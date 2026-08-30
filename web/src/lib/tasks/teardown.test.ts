import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    task: { delete: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    ptySession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    scheduledMessage: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    taskRuntimeState: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    message: { deleteMany: vi.fn() },
    agentOutbox: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn().mockReturnValue(""),
    waitForTaskStopAck: vi.fn().mockResolvedValue(undefined),
    cancelTaskStopAck: vi.fn(),
    bindTaskToAgent: vi.fn(),
    sendToAgentHost: vi.fn(),
    unbindTask: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn().mockResolvedValue({ delivered: false }),
}));

vi.mock("@/lib/tasks/task-file-storage", () => ({
  deleteTaskAttachmentDirectory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tasks/attached-terminal", () => ({
  findAttachedTerminalForAiTask: vi.fn().mockResolvedValue(null),
  deletePtyTaskWithKill: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tasks/worktree", () => ({
  parseTaskWorktreeLaunchConfig: vi.fn().mockReturnValue(null),
  resolveTaskWorktreeCleanupHost: vi.fn().mockReturnValue(""),
  acquireTaskWorktreeMutationLock: vi.fn(),
  buildTaskWorktreeCleanupOutboxData: vi.fn(),
  hasSameTaskWorktreeRoot: vi.fn().mockReturnValue(false),
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { deleteTaskAttachmentDirectory } = await import("@/lib/tasks/task-file-storage");
const {
  buildTaskWorktreeCleanupOutboxData,
  hasSameTaskWorktreeRoot,
  parseTaskWorktreeLaunchConfig,
  resolveTaskWorktreeCleanupHost,
} = await import("@/lib/tasks/worktree");
const { teardownTaskRuntime } = await import("./teardown");

const baseTask = {
  id: "ai-1",
  projectId: "proj-1",
  taskType: "ai_task" as const,
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  status: "killed",
  launchConfig: null,
  metadata: null,
  project: { daemonHost: "daemon-a" },
};

describe("teardownTaskRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.$transaction).mockImplementation(
      async (callback: any) => callback(db as any),
    );
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.task.update).mockResolvedValue({} as any);
    vi.mocked(db.scheduledMessage.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.ptySession.deleteMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(db.taskRuntimeState.deleteMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(parseTaskWorktreeLaunchConfig).mockReturnValue(null);
    vi.mocked(resolveTaskWorktreeCleanupHost).mockReturnValue("");
  });

  const archivePatch = {
    achievedAt: new Date("2026-07-27T00:00:00.000Z"),
  };

  it("drops runtime rows but PRESERVES the transcript and task row", async () => {
    const result = await teardownTaskRuntime({
      userId: "user-1",
      task: baseTask,
      reason: "achieved_by_user",
      archivePatch,
      deleteAttachmentDirectory: false,
    });

    expect(result.ok).toBe(true);
    expect(db.scheduledMessage.updateMany).toHaveBeenCalledWith({
      where: { taskId: "ai-1", status: "active" },
      data: { status: "canceled", updatedAt: expect.any(Date) },
    });
    // Runtime rows removed.
    expect(db.ptySession.deleteMany).toHaveBeenCalledWith({ where: { taskId: "ai-1" } });
    expect(db.taskRuntimeState.deleteMany).toHaveBeenCalledWith({ where: { taskId: "ai-1" } });
    // Transcript + task row are retained; the archive stamp is committed in
    // the same transaction as the runtime cleanup.
    expect(db.message.deleteMany).not.toHaveBeenCalled();
    expect(db.task.delete).not.toHaveBeenCalled();
    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "ai-1" },
      data: archivePatch,
    });
    // Attachment dir kept (achieve passes false); hub unbound.
    expect(deleteTaskAttachmentDirectory).not.toHaveBeenCalled();
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("ai-1");
  });

  it("does not dispatch stop_task for an already-terminal task", async () => {
    const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");
    await teardownTaskRuntime({
      userId: "user-1",
      task: baseTask, // status: killed
      reason: "achieved_by_user",
      archivePatch,
    });
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("only treats unarchived siblings as shared-worktree users", async () => {
    vi.mocked(parseTaskWorktreeLaunchConfig).mockReturnValue({ root: "/tmp/wt" } as any);
    vi.mocked(resolveTaskWorktreeCleanupHost).mockReturnValue("daemon-a");
    vi.mocked(hasSameTaskWorktreeRoot).mockReturnValue(false);
    vi.mocked(buildTaskWorktreeCleanupOutboxData).mockReturnValue({
      eventType: "cleanup_task_worktree",
    } as any);

    await teardownTaskRuntime({
      userId: "user-1",
      task: { ...baseTask, launchConfig: JSON.stringify({ worktree: true }) },
      reason: "achieved_by_user",
      archivePatch,
    });

    expect(db.task.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        id: { not: "ai-1" },
        achievedAt: null,
      },
      select: { id: true, launchConfig: true },
    });
    expect(db.agentOutbox.create).toHaveBeenCalledWith({
      data: { eventType: "cleanup_task_worktree" },
    });
  });

  // Regression: a reviewer sharing the worker's worktree must be visible to the
  // sibling guard. If reviewers only carried a bare `cwd`,
  // parseTaskWorktreeLaunchConfig would return null for them,
  // hasSameTaskWorktreeRoot would report "not shared", and archiving the worker
  // would enqueue a force cleanup that deletes the directory the reviewer is
  // still running in.
  it("keeps the shared worktree while a reuse-only reviewer is still active", async () => {
    const actualWorktree =
      await vi.importActual<typeof import("./worktree")>("./worktree");
    const workerLaunchConfig = actualWorktree.buildTaskWorktreeLaunchConfig({
      launchConfig: null,
      worktreeId: "ai-1",
      projectRepoRoot: "/repo",
      projectWorkspacePath: "/repo",
    });
    const reviewerLaunchConfig = actualWorktree.inheritTaskWorktreeLaunchConfig(
      workerLaunchConfig,
      { reuseOnly: true },
    );
    expect(reviewerLaunchConfig?.worktreeReuseOnly).toBe(true);

    vi.mocked(parseTaskWorktreeLaunchConfig).mockImplementation(
      actualWorktree.parseTaskWorktreeLaunchConfig,
    );
    vi.mocked(hasSameTaskWorktreeRoot).mockImplementation(
      actualWorktree.hasSameTaskWorktreeRoot,
    );
    vi.mocked(resolveTaskWorktreeCleanupHost).mockReturnValue("daemon-a");
    vi.mocked(db.task.findMany).mockResolvedValue([
      { id: "ai-reviewer", launchConfig: JSON.stringify(reviewerLaunchConfig) },
    ] as any);

    await teardownTaskRuntime({
      userId: "user-1",
      task: { ...baseTask, launchConfig: JSON.stringify(workerLaunchConfig) },
      reason: "achieved_by_user",
      archivePatch,
    });

    expect(db.agentOutbox.create).not.toHaveBeenCalled();
  });

  it("cleans up the shared worktree once the last reviewer is archived", async () => {
    const actualWorktree =
      await vi.importActual<typeof import("./worktree")>("./worktree");
    const workerLaunchConfig = actualWorktree.buildTaskWorktreeLaunchConfig({
      launchConfig: null,
      worktreeId: "ai-1",
      projectRepoRoot: "/repo",
      projectWorkspacePath: "/repo",
    });

    vi.mocked(parseTaskWorktreeLaunchConfig).mockImplementation(
      actualWorktree.parseTaskWorktreeLaunchConfig,
    );
    vi.mocked(hasSameTaskWorktreeRoot).mockImplementation(
      actualWorktree.hasSameTaskWorktreeRoot,
    );
    vi.mocked(resolveTaskWorktreeCleanupHost).mockReturnValue("daemon-a");
    vi.mocked(buildTaskWorktreeCleanupOutboxData).mockReturnValue({
      eventType: "cleanup_task_worktree",
    } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);

    await teardownTaskRuntime({
      userId: "user-1",
      task: { ...baseTask, launchConfig: JSON.stringify(workerLaunchConfig) },
      reason: "achieved_by_user",
      archivePatch,
    });

    expect(db.agentOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("rechecks worktree usage after archiving when a sibling initially blocks cleanup", async () => {
    vi.mocked(parseTaskWorktreeLaunchConfig).mockReturnValue({ root: "/tmp/wt" } as any);
    vi.mocked(resolveTaskWorktreeCleanupHost).mockReturnValue("daemon-a");
    vi.mocked(hasSameTaskWorktreeRoot).mockReturnValue(true);
    vi.mocked(db.task.findMany)
      .mockResolvedValueOnce([
        { id: "ai-2", launchConfig: JSON.stringify({ worktree: true }) },
      ] as any)
      .mockResolvedValueOnce([] as any);
    vi.mocked(buildTaskWorktreeCleanupOutboxData).mockReturnValue({
      eventType: "cleanup_task_worktree",
    } as any);

    await teardownTaskRuntime({
      userId: "user-1",
      task: { ...baseTask, launchConfig: JSON.stringify({ worktree: true }) },
      reason: "achieved_by_user",
      archivePatch,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.task.findMany).toHaveBeenCalledTimes(2);
    expect(db.agentOutbox.create).toHaveBeenCalledTimes(1);
  });
});
