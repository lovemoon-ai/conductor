import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    taskStatusEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/channel/task-event-projector", () => ({
  projectTaskMessage: vi.fn(),
  projectTaskStatusUpdate: vi.fn(),
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  acknowledgeAgentCommand: vi.fn(),
  deliverAgentOutboxForHost: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    bindTaskToAgent: vi.fn(),
    getTaskAgentHost: vi.fn(),
    hasAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

const { db } = await import("@/lib/db");
const { projectTaskStatusUpdate } = await import("@/lib/channel/task-event-projector");
const { deliverAgentOutboxForHost } = await import("@/lib/realtime/agent-outbox");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { commitTaskStatusUpdate } = await import("./agent-upstream");

describe("commitTaskStatusUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      status: "killing",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      taskType: "ai_task",
    } as any);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(deliverAgentOutboxForHost).mockResolvedValue({ attempted: 0, delivered: 0 });
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
  });

  it("does not let a late running update overwrite killing", async () => {
    const result = await commitTaskStatusUpdate({
      userId: "user-1",
      agentHost: "daemon-a",
      taskId: "task-1",
      status: "running",
    });

    expect(result).toEqual({
      taskId: "task-1",
      projectId: "project-1",
      status: "killing",
      duplicate: false,
    });
    expect(db.task.update).not.toHaveBeenCalled();
    expect(projectTaskStatusUpdate).not.toHaveBeenCalled();
  });

  it("allows a terminal update to finish killing", async () => {
    const result = await commitTaskStatusUpdate({
      userId: "user-1",
      agentHost: "daemon-a",
      taskId: "task-1",
      status: "killed",
      summary: "Stopped",
    });

    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { status: "killed" },
    });
    expect(projectTaskStatusUpdate).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      taskId: "task-1",
      status: "killed",
      summary: "Stopped",
    });
    expect(result.status).toBe("killed");
  });
});
