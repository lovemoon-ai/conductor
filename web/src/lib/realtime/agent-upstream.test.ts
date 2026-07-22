import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;

      constructor(message: string, options: { code?: string } = {}) {
        super(message);
        this.code = options.code || "UNKNOWN";
      }
    },
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    agentOutbox: {
      findFirst: vi.fn(),
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
  enqueueAndAttemptAgentCommand: vi.fn(),
  isMissingAgentOutboxTableError: () => false,
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    acknowledgeAgentCommand: vi.fn(),
    bindTaskToAgent: vi.fn(),
    getTaskAgentHost: vi.fn(),
    hasAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

const { db } = await import("@/lib/db");
const { projectTaskStatusUpdate } = await import("@/lib/channel/task-event-projector");
const { acknowledgeAgentCommand, deliverAgentOutboxForHost, enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { commitAgentCommandAck, commitSdkMessage, commitTaskStatusUpdate } = await import("./agent-upstream");

describe("commitSdkMessage split-brain guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deliverAgentOutboxForHost).mockResolvedValue({ attempted: 0, delivered: 0 });
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 1 } as any);
  });

  it("drops SDK output for an already-killed task and re-stops the streaming host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      status: "killed",
      agentHost: "conductor-fire-a",
      executionHost: "conductor-fire-a",
      taskType: "ai_task",
    } as any);

    const result = await commitSdkMessage({
      userId: "user-1",
      agentHost: "conductor-fire-a",
      taskId: "task-1",
      content: "zombie reply",
      messageId: "msg-1",
    });

    expect(result).toEqual({
      taskId: "task-1",
      projectId: "project-1",
      messageId: "msg-1",
      duplicate: true,
      dropped: true,
    });
    // The dead task must NOT be resurrected: no message write.
    expect(db.$transaction).not.toHaveBeenCalled();
    // The zombie backend is durably stopped via the outbox (covers both the ws
    // and the stateless HTTP ingest path), with the outbox requestId matching
    // the envelope request_id so the fire's ack can clear the row.
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledTimes(1);
    const [enqueueInput] = vi.mocked(enqueueAndAttemptAgentCommand).mock.calls[0];
    expect(enqueueInput).toMatchObject({
      userId: "user-1",
      agentHost: "conductor-fire-a",
      taskId: "task-1",
      eventType: "stop_task",
      envelope: {
        type: "stop_task",
        payload: expect.objectContaining({
          task_id: "task-1",
          project_id: "project-1",
          reason: "task_already_killed",
        }),
      },
    });
    expect(enqueueInput.requestId).toBe(enqueueInput.envelope.payload.request_id);
  });

  it("commits SDK output normally for a running task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      status: "running",
      agentHost: "conductor-fire-a",
      executionHost: "conductor-fire-a",
      taskType: "ai_task",
    } as any);
    vi.mocked(db.$transaction).mockResolvedValue([
      { id: "message-1", createdAt: new Date("2026-07-22T00:00:00Z") },
      {},
    ] as any);

    const result = await commitSdkMessage({
      userId: "user-1",
      agentHost: "conductor-fire-a",
      taskId: "task-1",
      content: "live reply",
    });

    expect(result.dropped).toBeUndefined();
    expect(result.duplicate).toBe(false);
    expect(db.$transaction).toHaveBeenCalled();
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });
});

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
    vi.mocked(db.agentOutbox.findFirst).mockResolvedValue(null as any);
    vi.mocked(acknowledgeAgentCommand).mockResolvedValue({ count: 1 } as any);
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

  it("allows a terminal update to finish killing and tags killed_reason=user_stopped", async () => {
    // RFC 0029: transitioning from `killing` (which only the explicit user
    // PATCH path writes) into `killed` means the user is the cause of death,
    // so the next restart must spawn a fresh fire instead of reclaiming.
    const result = await commitTaskStatusUpdate({
      userId: "user-1",
      agentHost: "daemon-a",
      taskId: "task-1",
      status: "killed",
      summary: "Stopped",
    });

    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "killed",
        killedReason: "user_stopped",
        killedAt: expect.any(Date),
      }),
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

  it("tags killed_reason=fire_exit when the daemon reports a non-killing -> killed transition", async () => {
    // The defensive case: the fire ended on its own (graceful exit / crash)
    // and the task was never in `killing`. We default to `fire_exit` so the
    // reclaim path skips it (fires that already exited cannot be reclaimed).
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      taskType: "ai_task",
    } as any);

    await commitTaskStatusUpdate({
      userId: "user-1",
      agentHost: "daemon-a",
      taskId: "task-1",
      status: "killed",
    });

    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "killed",
        killedReason: "fire_exit",
        killedAt: expect.any(Date),
      }),
    });
  });

  it("rejects stale fire interrupt acknowledgements for another execution host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "conductor-fire-a",
      taskType: "ai_task",
    } as any);

    await expect(
      commitAgentCommandAck({
        userId: "user-1",
        agentHost: "conductor-fire-b",
        taskId: "task-1",
        requestId: "interrupt-1",
        eventType: "interrupt_turn",
        accepted: true,
      }),
    ).rejects.toThrow("Task task-1 is assigned to conductor-fire-a, not conductor-fire-b");

    expect(realtimeHub.acknowledgeAgentCommand).not.toHaveBeenCalled();
    expect(acknowledgeAgentCommand).not.toHaveBeenCalled();
  });

  it("records interrupt acknowledgements from the current execution host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "conductor-fire-a",
      taskType: "ai_task",
    } as any);

    await expect(
      commitAgentCommandAck({
        userId: "user-1",
        agentHost: "conductor-fire-a",
        taskId: "task-1",
        requestId: "interrupt-2",
        eventType: "interrupt_turn",
        accepted: true,
      }),
    ).resolves.toEqual({
      requestId: "interrupt-2",
      accepted: true,
      duplicate: false,
    });

    expect(realtimeHub.acknowledgeAgentCommand).toHaveBeenCalledWith("task-1", "interrupt-2", true, {
      agentHost: "conductor-fire-a",
      eventType: "interrupt_turn",
    });
    expect(acknowledgeAgentCommand).toHaveBeenCalledWith({
      userId: "user-1",
      requestId: "interrupt-2",
      accepted: true,
      eventType: "interrupt_turn",
    });
  });

  it("acks a stale command when the task was deleted after outbox delivery", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null as any);
    vi.mocked(db.agentOutbox.findFirst).mockResolvedValue({
      taskId: "deleted-task-1",
      agentHost: "daemon-a",
      eventType: "restart_task",
    } as any);

    await expect(
      commitAgentCommandAck({
        userId: "user-1",
        agentHost: "daemon-a",
        taskId: "deleted-task-1",
        requestId: "restart-1",
        eventType: "restart_task",
        accepted: true,
      }),
    ).resolves.toEqual({
      requestId: "restart-1",
      accepted: true,
      duplicate: false,
    });

    expect(realtimeHub.acknowledgeAgentCommand).not.toHaveBeenCalled();
    expect(acknowledgeAgentCommand).toHaveBeenCalledWith({
      userId: "user-1",
      requestId: "restart-1",
      accepted: true,
      eventType: "restart_task",
    });
  });

  it("rejects stale command acknowledgements from the wrong host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null as any);
    vi.mocked(db.agentOutbox.findFirst).mockResolvedValue({
      taskId: "deleted-task-1",
      agentHost: "daemon-a",
      eventType: "restart_task",
    } as any);

    await expect(
      commitAgentCommandAck({
        userId: "user-1",
        agentHost: "daemon-b",
        taskId: "deleted-task-1",
        requestId: "restart-1",
        eventType: "restart_task",
        accepted: true,
      }),
    ).rejects.toThrow("Task deleted-task-1 not found");

    expect(acknowledgeAgentCommand).not.toHaveBeenCalled();
  });
});
