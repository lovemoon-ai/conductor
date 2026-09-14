import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn(),
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
  // Treat the recovery host as a daemon (not a fire host) unless a test opts in.
  isConductorFireHost: vi.fn(() => false),
}));

const { db } = await import("@/lib/db");
const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { isConductorFireHost } = await import("@/lib/subscription/plan-limits");
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
    vi.mocked(isConductorFireHost).mockImplementation((() => false) as any);
  });

  it("enqueues a durable stop_task when it defensively kills a stale task", async () => {
    await recoverStaleDisconnectedAgentTasks("user-1", [buildStaleTask()] as any);

    // The task is defensively killed...
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "task-1" } }),
    );
    // ...AND a durable stop_task is queued for the (possibly still-alive) host
    // so the backend converges on reconnect instead of streaming a zombie.
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledTimes(1);
    const [enqueueInput] = vi.mocked(enqueueAndAttemptAgentCommand).mock.calls[0];
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
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
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
      expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
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

  // A daemon-launched ai_task can only take messages through its fire, so the
  // fire's liveness decides; the daemon only decides who receives the stop.
  describe("daemon-launched ai_task is judged by its fire", () => {
    const FIRE = "conductor-fire-ubuntu-task-1";
    const buildFireTask = (overrides: Record<string, unknown> = {}) => ({
      ...buildStaleTask(),
      taskType: "ai_task",
      agentHost: "ubuntu",
      executionHost: FIRE,
      ...overrides,
    });
    const setOnline = (...hosts: string[]) =>
      vi.mocked(realtimeHub.hasAgentHost).mockImplementation(((host: string) => hosts.includes(host)) as any);
    const stopTarget = () => vi.mocked(enqueueAndAttemptAgentCommand).mock.calls[0]?.[0]?.agentHost;

    beforeEach(() => {
      vi.mocked(isConductorFireHost).mockImplementation(
        ((host: unknown) => typeof host === "string" && host.startsWith("conductor-fire-")) as any,
      );
    });

    it("keeps the task when fire and daemon are both online", async () => {
      setOnline(FIRE, "ubuntu");

      await recoverStaleDisconnectedAgentTasks("user-1", [buildFireTask()] as any);

      expect(db.task.update).not.toHaveBeenCalled();
    });

    it("keeps the task when only the fire is online, even if the hub is bound to the daemon", async () => {
      // tmux fires outlive a restarting daemon; the boot-time binding points at the daemon.
      vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("ubuntu");
      setOnline(FIRE);

      await recoverStaleDisconnectedAgentTasks("user-1", [buildFireTask()] as any);

      expect(db.task.update).not.toHaveBeenCalled();
    });

    it("recognises the fire by its derived name when executionHost was cleared", async () => {
      setOnline(FIRE);

      await recoverStaleDisconnectedAgentTasks("user-1", [buildFireTask({ executionHost: null })] as any);

      expect(db.task.update).not.toHaveBeenCalled();
    });

    it("kills and queues the stop for the fire when both are offline", async () => {
      setOnline();

      await recoverStaleDisconnectedAgentTasks("user-1", [buildFireTask()] as any);

      expect(db.task.update).toHaveBeenCalledTimes(1);
      expect(stopTarget()).toBe(FIRE);
    });

    it.each([
      ["executionHost was cleared (revived zombie)", { executionHost: null }, null],
      ["the hub is still bound to the daemon", {}, "ubuntu"],
    ])("kills and stops through the daemon when the fire is gone but %s", async (_label, overrides, bound) => {
      vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(bound);
      setOnline("ubuntu");

      await recoverStaleDisconnectedAgentTasks("user-1", [buildFireTask(overrides)] as any);

      expect(db.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task-1" },
          data: expect.objectContaining({ status: "killed", killedReason: "daemon_disconnected" }),
        }),
      );
      expect(stopTarget()).toBe("ubuntu");
    });

    it("gives the fire the longer window before the daemon stops it", async () => {
      setOnline("ubuntu");
      vi.mocked(realtimeHub.getAgentDisconnectAt as any).mockImplementation((host: string) =>
        host === FIRE ? Date.now() - 60_000 : null,
      );

      await recoverStaleDisconnectedAgentTasks("user-1", [buildFireTask()] as any);

      expect(db.task.update).not.toHaveBeenCalled();
    });

    it("leaves a pty task on a connected daemon alone", async () => {
      setOnline("ubuntu");

      await recoverStaleDisconnectedAgentTasks("user-1", [
        buildFireTask({ taskType: "pty_task", executionHost: "ubuntu" }),
      ] as any);

      expect(db.task.update).not.toHaveBeenCalled();
    });
  });
});
