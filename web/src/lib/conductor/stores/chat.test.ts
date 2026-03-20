import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types";

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock("../api/client", () => ({
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
});
