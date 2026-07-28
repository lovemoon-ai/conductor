import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from '@/shared/types';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('@/shared/api/client', () => {
  class ApiRequestError extends Error {
    status: number;
    payload: { error: string; message?: string; code?: string };
    constructor(status: number, payload: { error: string; message?: string; code?: string }) {
      super(payload.message || payload.error || `HTTP ${status}`);
      this.name = 'ApiRequestError';
      this.status = status;
      this.payload = payload;
    }
  }
  return {
    getApiClient: () => ({
      get: mockGet,
      post: mockPost,
    }),
    ApiRequestError,
  };
});

import { ApiRequestError } from "@/shared/api/client";
import { useChatStore } from "./store";

const fireOwnerNotReady = () =>
  new ApiRequestError(409, {
    error: "Task missing active fire owner",
    code: "task_missing_active_fire_owner",
  });

describe("useChatStore sendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesByTask: {},
      historyStateByTask: {},
      hydratedTaskIds: new Set(),
      loadingTasks: new Set(),
      error: null,
    });
  });

  it("deduplicates when websocket message arrives before POST response", async () => {
    const taskId = "task-1";
    let resolvePost!: (value: {
      id: string;
      task_id: string;
      role: string;
      content: string;
      created_at: string;
    }) => void;

    mockPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve as typeof resolvePost;
        })
    );

    const sendPromise = useChatStore.getState().sendMessage(taskId, {
      content: "hello",
      role: "user",
    });

    const afterOptimistic = useChatStore.getState().messagesByTask[taskId] ?? [];
    expect(afterOptimistic).toHaveLength(1);
    expect(afterOptimistic[0].id.startsWith("temp-")).toBe(true);

    const wsMessage: Message = {
      id: "msg-1",
      taskId,
      role: "user",
      content: "hello",
      createdAt: "2026-02-07T00:00:00.000Z",
    };
    useChatStore.getState().addMessage(taskId, wsMessage);

    const afterWs = useChatStore.getState().messagesByTask[taskId] ?? [];
    expect(afterWs).toHaveLength(2);

    resolvePost({
      id: "msg-1",
      task_id: taskId,
      role: "user",
      content: "hello",
      created_at: "2026-02-07T00:00:01.000Z",
    });

    await sendPromise;

    const finalMessages = useChatStore.getState().messagesByTask[taskId] ?? [];
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]).toMatchObject({
      id: "msg-1",
      taskId,
      role: "user",
      content: "hello",
      createdAt: "2026-02-07T00:00:01.000Z",
    });
  });

  it("auto-retries the startup fire-owner 409 and succeeds when the fire binds", async () => {
    vi.useFakeTimers();
    try {
      const taskId = "task-1";
      mockPost
        .mockRejectedValueOnce(fireOwnerNotReady())
        .mockRejectedValueOnce(fireOwnerNotReady())
        .mockResolvedValueOnce({
          id: "msg-1",
          task_id: taskId,
          role: "user",
          content: "hi",
          created_at: "2026-02-07T00:00:01.000Z",
        });

      const sendPromise = useChatStore.getState().sendMessage(taskId, {
        content: "hi",
        role: "user",
      });

      // Optimistic bubble stays visible across the retries (never dropped).
      expect(useChatStore.getState().messagesByTask[taskId]).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5_000);
      const message = await sendPromise;

      expect(message.id).toBe("msg-1");
      expect(mockPost).toHaveBeenCalledTimes(3);
      const bodies = mockPost.mock.calls.map((call) => call[1] as { client_request_id?: string });
      // Same idempotency key on every retry so a late success cannot double-send.
      expect(bodies[0].client_request_id).toBeTruthy();
      expect(bodies[1].client_request_id).toBe(bodies[0].client_request_id);
      expect(bodies[2].client_request_id).toBe(bodies[0].client_request_id);
      expect(useChatStore.getState().messagesByTask[taskId]).toHaveLength(1);
      expect(useChatStore.getState().messagesByTask[taskId]?.[0].id).toBe("msg-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the retry window and drops the optimistic bubble", async () => {
    vi.useFakeTimers();
    try {
      const taskId = "task-1";
      mockPost.mockRejectedValue(fireOwnerNotReady());

      const sendPromise = useChatStore.getState().sendMessage(taskId, {
        content: "hi",
        role: "user",
      });
      const rejection = expect(sendPromise).rejects.toMatchObject({ status: 409 });

      await vi.advanceTimersByTimeAsync(11_000);
      await rejection;

      expect(useChatStore.getState().messagesByTask[taskId] ?? []).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-fire-owner failures", async () => {
    const taskId = "task-1";
    mockPost.mockRejectedValue(
      new ApiRequestError(409, { error: "Task archived", code: "task_archived" }),
    );

    await expect(
      useChatStore.getState().sendMessage(taskId, { content: "hi", role: "user" }),
    ).rejects.toMatchObject({ status: 409 });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messagesByTask[taskId] ?? []).toHaveLength(0);
  });

  it("does not refetch hydrated task messages", async () => {
    useChatStore.setState({
      messagesByTask: {
        "task-1": [
          {
            id: "msg-1",
            taskId: "task-1",
            role: "assistant",
            content: "cached",
            createdAt: "2026-02-07T00:00:00.000Z",
          },
        ],
      },
      hydratedTaskIds: new Set(["task-1"]),
      loadingTasks: new Set(),
      error: null,
    });

    await useChatStore.getState().fetchMessages("task-1");

    expect(mockGet).not.toHaveBeenCalled();
  });

  it("refetches when messages only came from websocket and task is not hydrated", async () => {
    useChatStore.setState({
      messagesByTask: {
        "task-1": [
          {
            id: "ws-msg-1",
            taskId: "task-1",
            role: "assistant",
            content: "latest only",
            createdAt: "2026-02-07T00:00:00.000Z",
          },
        ],
      },
      hydratedTaskIds: new Set(),
      loadingTasks: new Set(),
      error: null,
    });
    mockGet.mockResolvedValueOnce({
      messages: [
        {
          id: "msg-1",
          task_id: "task-1",
          role: "assistant",
          content: "full history",
          created_at: "2026-02-07T00:00:01.000Z",
        },
      ],
      pagination: {
        has_more_before: false,
        oldest_message_id: "msg-1",
      },
    });

    await useChatStore.getState().fetchMessages("task-1");

    expect(mockGet).toHaveBeenCalledWith("/tasks/task-1/messages?limit=50&pagination=1");
    expect(useChatStore.getState().hydratedTaskIds.has("task-1")).toBe(true);
    expect(useChatStore.getState().messagesByTask["task-1"]).toMatchObject([
      {
        id: "msg-1",
        content: "full history",
      },
    ]);
    expect(useChatStore.getState().historyStateByTask["task-1"]).toEqual({
      hasMoreBefore: false,
      oldestMessageId: "msg-1",
    });
  });

  it("prepends older messages when loading more history", async () => {
    useChatStore.setState({
      messagesByTask: {
        "task-1": [
          {
            id: "msg-3",
            taskId: "task-1",
            role: "assistant",
            content: "newer",
            createdAt: "2026-02-07T00:00:03.000Z",
          },
          {
            id: "msg-4",
            taskId: "task-1",
            role: "assistant",
            content: "newest",
            createdAt: "2026-02-07T00:00:04.000Z",
          },
        ],
      },
      historyStateByTask: {
        "task-1": {
          hasMoreBefore: true,
          oldestMessageId: "msg-3",
        },
      },
      hydratedTaskIds: new Set(["task-1"]),
      loadingTasks: new Set(),
      error: null,
    });
    mockGet.mockResolvedValueOnce({
      messages: [
        {
          id: "msg-1",
          task_id: "task-1",
          role: "user",
          content: "older-1",
          created_at: "2026-02-07T00:00:01.000Z",
        },
        {
          id: "msg-2",
          task_id: "task-1",
          role: "assistant",
          content: "older-2",
          created_at: "2026-02-07T00:00:02.000Z",
        },
      ],
      pagination: {
        has_more_before: false,
        oldest_message_id: "msg-1",
      },
    });

    await useChatStore.getState().fetchMessages("task-1", { beforeId: "msg-3" });

    expect(mockGet).toHaveBeenCalledWith("/tasks/task-1/messages?limit=50&pagination=1&before_id=msg-3");
    expect(useChatStore.getState().messagesByTask["task-1"]?.map((message) => message.id)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
    expect(useChatStore.getState().historyStateByTask["task-1"]).toEqual({
      hasMoreBefore: false,
      oldestMessageId: "msg-1",
    });
  });

  it("accepts legacy array responses from older backends", async () => {
    mockGet.mockResolvedValueOnce([
      {
        id: "msg-1",
        task_id: "task-1",
        role: "assistant",
        content: "legacy history",
        created_at: "2026-02-07T00:00:01.000Z",
      },
    ]);

    await useChatStore.getState().fetchMessages("task-1");

    expect(mockGet).toHaveBeenCalledWith("/tasks/task-1/messages?limit=50&pagination=1");
    expect(useChatStore.getState().messagesByTask["task-1"]).toMatchObject([
      {
        id: "msg-1",
        content: "legacy history",
      },
    ]);
    expect(useChatStore.getState().historyStateByTask["task-1"]).toEqual({
      hasMoreBefore: false,
      oldestMessageId: "msg-1",
    });
  });

  it("force refresh merges latest page without dropping previously loaded older history", async () => {
    useChatStore.setState({
      messagesByTask: {
        "task-1": [
          {
            id: "msg-1",
            taskId: "task-1",
            role: "user",
            content: "older",
            createdAt: "2026-02-07T00:00:01.000Z",
          },
          {
            id: "msg-2",
            taskId: "task-1",
            role: "assistant",
            content: "middle",
            createdAt: "2026-02-07T00:00:02.000Z",
          },
        ],
      },
      historyStateByTask: {
        "task-1": {
          hasMoreBefore: true,
          oldestMessageId: "msg-1",
        },
      },
      hydratedTaskIds: new Set(["task-1"]),
      loadingTasks: new Set(),
      error: null,
    });
    mockGet.mockResolvedValueOnce({
      messages: [
        {
          id: "msg-2",
          task_id: "task-1",
          role: "assistant",
          content: "middle-updated",
          created_at: "2026-02-07T00:00:02.000Z",
        },
        {
          id: "msg-3",
          task_id: "task-1",
          role: "assistant",
          content: "latest",
          created_at: "2026-02-07T00:00:03.000Z",
        },
      ],
      pagination: {
        has_more_before: false,
        oldest_message_id: "msg-2",
      },
    });

    await useChatStore.getState().fetchMessages("task-1", { force: true });

    expect(useChatStore.getState().messagesByTask["task-1"]?.map((message) => message.id)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
    expect(useChatStore.getState().messagesByTask["task-1"]?.[1]).toMatchObject({
      id: "msg-2",
      content: "middle-updated",
    });
    expect(useChatStore.getState().historyStateByTask["task-1"]).toEqual({
      hasMoreBefore: true,
      oldestMessageId: "msg-1",
    });
  });
});
