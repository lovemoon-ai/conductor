import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/messages/route";
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
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    getTaskAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");

describe("/api/tasks/[taskId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  it("rejects POST for pty_task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-1",
      projectId: "proj-1",
      taskType: "pty_task",
      agentHost: "daemon-1",
      executionHost: "daemon-1",
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-pty-1/messages",
        body: { content: "hello terminal" },
      }),
      { params: Promise.resolve({ taskId: "task-pty-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "task_type_not_messageable",
      message: "pty_task does not accept chat messages",
    });
    expect(db.message.create).not.toHaveBeenCalled();
    expect(realtimeHub.broadcast).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });
});
