import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from '@/shared/types';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: mockGet,
    post: mockPost,
  }),
}));

import { useChatStore } from "./chat";

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
