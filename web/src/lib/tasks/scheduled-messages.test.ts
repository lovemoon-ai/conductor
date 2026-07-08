import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
    scheduledMessage: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    taskRuntimeState: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/channel/task-ingress-service", () => ({
  appendUserMessageToTask: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { appendUserMessageToTask } = await import("@/lib/channel/task-ingress-service");
const {
  cancelScheduledMessageForTask,
  createScheduledMessageForTask,
  persistTaskRuntimeState,
  processDueScheduledMessages,
} = await import("./scheduled-messages");

const date = (value: string) => new Date(value);

const makeScheduledRow = (overrides: Record<string, unknown> = {}) => ({
  id: "sched-1",
  userId: "user-1",
  taskId: "task-1",
  sourceMessageId: "msg-1",
  content: "hello later",
  kind: "interval",
  condition: "none",
  intervalMs: 60_000,
  timezone: null,
  status: "active",
  nextRunAt: date("2026-06-07T10:00:00.000Z"),
  runCount: 0,
  skipCount: 0,
  failureCount: 0,
  maxRuns: null,
  maxSkips: null,
  stopAt: null,
  stopWhenTaskNotRunning: true,
  lastRunAt: null,
  lastError: null,
  metadata: null,
  createdAt: date("2026-06-07T09:00:00.000Z"),
  updatedAt: date("2026-06-07T09:00:00.000Z"),
  ...overrides,
});

describe("scheduled messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      taskType: "ai_task",
    } as any);
    (db.scheduledMessage.create as any).mockImplementation(async ({ data }: any) =>
      makeScheduledRow({
        ...data,
        id: "sched-created",
        createdAt: date("2026-06-07T09:00:00.000Z"),
        updatedAt: date("2026-06-07T09:00:00.000Z"),
      }) as any,
    );
    vi.mocked(db.scheduledMessage.findMany).mockResolvedValue([]);
    vi.mocked(db.scheduledMessage.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.scheduledMessage.update).mockResolvedValue({} as any);
    vi.mocked(db.message.findFirst).mockResolvedValue({ id: "msg-1" } as any);
    vi.mocked(db.message.findMany).mockResolvedValue([]);
    vi.mocked(appendUserMessageToTask).mockResolvedValue({} as any);
  });

  it("creates a delayed scheduled message for an ai task", async () => {
    const result = await createScheduledMessageForTask({
      userId: "user-1",
      taskId: "task-1",
      sourceMessageId: "msg-1",
      content: "  hello later  ",
      now: date("2026-06-07T10:00:00.000Z"),
      schedule: {
        mode: "delay",
        amount: 10,
        unit: "minute",
      },
    });

    expect(result.id).toBe("sched-created");
    expect(db.scheduledMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        taskId: "task-1",
        sourceMessageId: "msg-1",
        content: "hello later",
        kind: "once_delay",
        condition: "none",
        nextRunAt: date("2026-06-07T10:10:00.000Z"),
      }),
    });
  });

  it("rejects a source message that does not belong to the task", async () => {
    vi.mocked(db.message.findFirst).mockResolvedValue(null);

    await expect(
      createScheduledMessageForTask({
        userId: "user-1",
        taskId: "task-1",
        sourceMessageId: "msg-other-task",
        content: "hello later",
        now: date("2026-06-07T10:00:00.000Z"),
        schedule: {
          mode: "delay",
          amount: 10,
          unit: "minute",
        },
      }),
    ).rejects.toMatchObject({
      code: "source_message_not_found",
      status: 404,
    });

    expect(db.scheduledMessage.create).not.toHaveBeenCalled();
  });

  it("rejects intervals that cannot fit in the persisted millisecond field", async () => {
    await expect(
      createScheduledMessageForTask({
        userId: "user-1",
        taskId: "task-1",
        sourceMessageId: "msg-1",
        content: "hello later",
        now: date("2026-06-07T10:00:00.000Z"),
        schedule: {
          mode: "interval",
          every: 1000,
          unit: "hour",
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_schedule",
      status: 400,
    });

    expect(db.scheduledMessage.create).not.toHaveBeenCalled();
  });

  it("only cancels active schedules so worker-owned sends are not overwritten", async () => {
    vi.mocked(db.scheduledMessage.updateMany).mockResolvedValue({ count: 0 } as any);

    const canceled = await cancelScheduledMessageForTask({
      userId: "user-1",
      taskId: "task-1",
      scheduleId: "sched-1",
    });

    expect(canceled).toBe(false);
    expect(db.scheduledMessage.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sched-1",
        userId: "user-1",
        taskId: "task-1",
        status: "active",
      },
      data: expect.objectContaining({
        status: "canceled",
      }),
    });
  });

  it("skips an idle-gated interval while the AI reply is in progress", async () => {
    const due = makeScheduledRow({
      condition: "ai_idle",
      nextRunAt: date("2026-06-07T10:00:00.000Z"),
    });
    vi.mocked(db.scheduledMessage.findMany).mockResolvedValue([due] as any);
    vi.mocked(db.scheduledMessage.findUnique).mockResolvedValue({
      ...due,
      task: {
        id: "task-1",
        projectId: "proj-1",
        status: "running",
        taskType: "ai_task",
        runtimeState: {
          replyInProgress: true,
          updatedAt: date("2026-06-07T09:59:00.000Z"),
        },
      },
    } as any);

    const stats = await processDueScheduledMessages({
      now: date("2026-06-07T10:00:00.000Z"),
    });

    expect(stats).toMatchObject({ scanned: 1, claimed: 1, skipped: 1 });
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
    expect(db.scheduledMessage.update).toHaveBeenCalledWith({
      where: { id: "sched-1" },
      data: expect.objectContaining({
        status: "active",
        skipCount: 1,
        nextRunAt: date("2026-06-07T10:01:00.000Z"),
        lastError: "ai_reply_in_progress",
      }),
    });
  });

  it("sends a due interval message through task ingress when the task is running", async () => {
    const due = makeScheduledRow();
    vi.mocked(db.scheduledMessage.findMany).mockResolvedValue([due] as any);
    vi.mocked(db.scheduledMessage.findUnique).mockResolvedValue({
      ...due,
      task: {
        id: "task-1",
        projectId: "proj-1",
        status: "running",
        taskType: "ai_task",
        runtimeState: null,
      },
    } as any);

    const stats = await processDueScheduledMessages({
      now: date("2026-06-07T10:00:00.000Z"),
    });

    expect(stats).toMatchObject({ scanned: 1, claimed: 1, sent: 1 });
    expect(appendUserMessageToTask).toHaveBeenCalledWith({
      userId: "user-1",
      taskId: "task-1",
      role: "user",
      content: "hello later",
      clientMessageId: "scheduled-message:sched-1:1",
      metadata: {
        scheduledMessageId: "sched-1",
        scheduledRun: 1,
        clientRequestId: "scheduled-message:sched-1:1",
        sourceMessageId: "msg-1",
      },
    });
    expect(db.scheduledMessage.update).toHaveBeenCalledWith({
      where: { id: "sched-1" },
      data: expect.objectContaining({
        status: "active",
        runCount: 1,
        nextRunAt: date("2026-06-07T10:01:00.000Z"),
        lastError: null,
      }),
    });
  });

  it("reclaims stale sending rows before scanning due schedules", async () => {
    vi.mocked(db.scheduledMessage.findMany).mockResolvedValue([]);

    const stats = await processDueScheduledMessages({
      now: date("2026-06-07T10:10:00.000Z"),
    });

    expect(stats).toMatchObject({ scanned: 0, claimed: 0 });
    expect(db.scheduledMessage.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: "sending",
        updatedAt: { lte: date("2026-06-07T10:05:00.000Z") },
      },
      data: {
        status: "active",
        nextRunAt: date("2026-06-07T10:10:00.000Z"),
        lastError: "sending_timeout",
        updatedAt: date("2026-06-07T10:10:00.000Z"),
      },
    });
  });

  it("persists runtime state snapshots for scheduler-side idle checks", async () => {
    await persistTaskRuntimeState({
      taskId: "task-1",
      projectId: "proj-1",
      replyInProgress: true,
      statusLine: "Working",
      replyTo: "msg-1",
      sessionId: "session-1",
    });

    expect(db.taskRuntimeState.upsert).toHaveBeenCalledWith({
      where: { taskId: "task-1" },
      create: expect.objectContaining({
        taskId: "task-1",
        projectId: "proj-1",
        replyInProgress: true,
      }),
      update: expect.objectContaining({
        projectId: "proj-1",
        replyInProgress: true,
        statusLine: "Working",
        replyTo: "msg-1",
        sessionId: "session-1",
      }),
    });
  });
});
