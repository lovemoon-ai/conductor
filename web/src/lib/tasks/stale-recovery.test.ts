import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAgentCommand: vi.fn(),
  isMissingAgentOutboxTableError: () => false,
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn(),
    hasAgentHost: vi.fn(),
    getAgentDisconnectAt: vi.fn(),
    unbindTask: vi.fn(),
    notifyTaskStatus: vi.fn(),
    broadcast: vi.fn(),
  },
}));

vi.mock("@/lib/subscription/plan-limits", () => ({
  // Treat the recovery host as a daemon (not a fire host) for these tests.
  isConductorFireHost: () => false,
}));

const { db } = await import("@/lib/db");
const { enqueueAgentCommand } = await import("@/lib/realtime/agent-outbox");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { recoverStaleDisconnectedAgentTasks } = await import("./stale-recovery");

const buildStaleTask = () => ({
  id: "task-1",
  projectId: "project-1",
  status: "running",
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  createdAt: new Date("2020-01-01T00:00:00Z"),
  updatedAt: new Date("2020-01-01T00:00:00Z"),
});

describe("recoverStaleDisconnectedAgentTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.task.update).mockResolvedValue({} as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    // A concrete, long-past disconnect timestamp bypasses the boot-time floor
    // and makes the offline window exceed the recovery timeout deterministically.
    vi.mocked(realtimeHub.getAgentDisconnectAt as any).mockReturnValue(1);
  });

  it("enqueues a durable stop_task when it defensively kills a stale task", async () => {
    await recoverStaleDisconnectedAgentTasks("user-1", [buildStaleTask()] as any);

    // The task is defensively killed...
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "task-1" } }),
    );
    // ...AND a durable stop_task is queued for the (possibly still-alive) host
    // so the backend converges on reconnect instead of streaming a zombie.
    expect(enqueueAgentCommand).toHaveBeenCalledTimes(1);
    const [enqueueInput] = vi.mocked(enqueueAgentCommand).mock.calls[0];
    expect(enqueueInput).toMatchObject({
      userId: "user-1",
      agentHost: "daemon-a",
      taskId: "task-1",
      eventType: "stop_task",
      envelope: {
        type: "stop_task",
        payload: expect.objectContaining({
          task_id: "task-1",
          project_id: "project-1",
          reason: "recovered_stale_disconnect",
        }),
      },
    });
    // The outbox row id and the envelope request_id MUST match so the fire's
    // ack can clear the row (regression guard for the two-UUID bug).
    expect(enqueueInput.requestId).toBe(enqueueInput.envelope.payload.request_id);
  });

  it("does not kill or enqueue when the host is still connected", async () => {
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);

    await recoverStaleDisconnectedAgentTasks("user-1", [buildStaleTask()] as any);

    expect(db.task.update).not.toHaveBeenCalled();
    expect(enqueueAgentCommand).not.toHaveBeenCalled();
  });

  // A task stuck mid-stop is invisible to the offline recovery path above: the
  // daemon is connected, so the disconnect clock never starts. Without its own
  // timeout it stays `killing` forever and cannot even be restarted, because
  // `killing` is not in RESTARTABLE_SOURCE_STATUSES.
  describe("killing convergence while the agent host is still connected", () => {
    const buildKillingTask = (killingStartedAt: string) => ({
      ...buildStaleTask(),
      status: "killing",
      metadata: JSON.stringify({ killingStartedAt, killingTimeoutMs: 60_000 }),
      updatedAt: new Date(killingStartedAt),
    });

    beforeEach(() => {
      vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    });

    it("forces killed with user_stopped once the convergence timeout elapses", async () => {
      const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();

      await recoverStaleDisconnectedAgentTasks("user-1", [buildKillingTask(longAgo)] as any);

      expect(db.task.update).toHaveBeenCalledTimes(1);
      const [updateArgs] = vi.mocked(db.task.update).mock.calls[0];
      expect(updateArgs).toMatchObject({
        where: { id: "task-1" },
        data: expect.objectContaining({
          status: "killed",
          killedReason: "user_stopped",
          executionHost: null,
        }),
      });
      expect(realtimeHub.broadcast).toHaveBeenCalledWith(
        "user-1",
        "project-1",
        expect.objectContaining({
          type: "task_status_update",
          payload: expect.objectContaining({ task_id: "task-1", status: "killed" }),
        }),
      );
    });

    it("does NOT enqueue a second stop_task (entering killing already queued one)", async () => {
      const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();

      await recoverStaleDisconnectedAgentTasks("user-1", [buildKillingTask(longAgo)] as any);

      // A duplicate un-acked stop row could later be drained against a fresh
      // in-place restart and kill the new run.
      expect(enqueueAgentCommand).not.toHaveBeenCalled();
    });

    it("leaves a recently-requested stop alone so a slow daemon can still finish", async () => {
      const justNow = new Date(Date.now() - 5_000).toISOString();

      await recoverStaleDisconnectedAgentTasks("user-1", [buildKillingTask(justNow)] as any);

      expect(db.task.update).not.toHaveBeenCalled();
    });

    it("falls back to updatedAt when metadata carries no killingStartedAt", async () => {
      const task = {
        ...buildStaleTask(),
        status: "killing",
        metadata: null,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      };

      await recoverStaleDisconnectedAgentTasks("user-1", [task] as any);

      expect(db.task.update).toHaveBeenCalledTimes(1);
    });

    it("leaves the task alone when the kill age cannot be determined at all", async () => {
      const task = {
        ...buildStaleTask(),
        status: "killing",
        metadata: null,
        updatedAt: null,
      };

      await recoverStaleDisconnectedAgentTasks("user-1", [task] as any);

      expect(db.task.update).not.toHaveBeenCalled();
    });
  });
});
