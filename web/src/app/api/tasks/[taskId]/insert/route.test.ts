import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/insert/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
    message: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
    waitForAgentCommandAck: vi.fn(),
  },
}));

vi.mock("@/lib/channel/task-ingress-service", () => {
  class FakeTaskIngressError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
    }
  }
  return {
    TaskIngressError: FakeTaskIngressError,
    appendUserMessageToTask: vi.fn(),
  };
});

vi.mock("@/shared/utils/message-attachments", () => ({
  buildMessageResponse: (message: any) => ({ id: message.id, content: message.content, role: message.role }),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { appendUserMessageToTask } = await import("@/lib/channel/task-ingress-service");

const runningTask = {
  id: "task-1",
  projectId: "proj-1",
  taskType: "ai_task",
  status: "running",
  agentHost: "conductor-fire-a",
  executionHost: "conductor-fire-a",
  metadata: JSON.stringify({ daemonName: "daemon-a" }),
  project: { daemonHost: "daemon-a" },
};

describe("/api/tasks/[taskId]/insert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(realtimeHub.waitForAgentCommandAck).mockResolvedValue(true);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-a");
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
    vi.mocked(appendUserMessageToTask).mockResolvedValue({
      task: runningTask,
      message: { id: "msg-new", content: "ping", role: "user" },
    } as any);
  });

  it("requires content", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/insert",
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: "content required" });
    expect(db.task.findFirst).not.toHaveBeenCalled();
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
  });

  it("persists the message and interrupts the in-flight turn with reason user_insert", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(runningTask as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/insert",
        body: { content: "ping", target_reply_to: "msg-user-1" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    // The inserted user message is delivered through the normal ingress path.
    expect(appendUserMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        taskId: "task-1",
        content: "ping",
        role: "user",
        metadata: expect.objectContaining({ insert: true }),
      }),
    );
    // ...and the running turn is interrupted so the inserted message runs next.
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "conductor-fire-a",
      {
        type: "interrupt_turn",
        payload: expect.objectContaining({
          task_id: "task-1",
          project_id: "proj-1",
          target_reply_to: "msg-user-1",
          reason: "user_insert",
          request_id: expect.any(String),
        }),
      },
    );
    expect(data).toEqual(
      expect.objectContaining({
        delivered: true,
        interrupted: true,
        task_id: "task-1",
        message_id: "msg-new",
        target_reply_to: "msg-user-1",
      }),
    );
    // The latest-user-message fallback must NOT run when target is explicit.
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("resolves the latest user message as the interrupt target when omitted", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(runningTask as any);
    vi.mocked(db.message.findFirst).mockResolvedValue({ id: "msg-latest" } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/insert",
        body: { content: "ping" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: "task-1", role: "user" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "conductor-fire-a",
      expect.objectContaining({
        payload: expect.objectContaining({ target_reply_to: "msg-latest", reason: "user_insert" }),
      }),
    );
    expect(data).toEqual(expect.objectContaining({ delivered: true, target_reply_to: "msg-latest" }));
  });

  it("still delivers the message (without interrupting) when no in-flight turn can be resolved", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(runningTask as any);
    vi.mocked(db.message.findFirst).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/insert",
        body: { content: "ping" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(appendUserMessageToTask).toHaveBeenCalled();
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
    expect(data).toEqual(
      expect.objectContaining({ delivered: true, interrupted: false, message_id: "msg-new" }),
    );
  });

  it("rejects insert for pty_task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...runningTask, taskType: "pty_task" } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/insert",
        body: { content: "ping" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "task_type_not_insertable",
      message: "pty_task does not support message insertion",
    });
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
  });

  it("rejects insert when the task is not running", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...runningTask, status: "completed" } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/insert",
        body: { content: "ping" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "task_not_running",
      message: "Only running ai_task supports message insertion",
    });
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
  });
});
