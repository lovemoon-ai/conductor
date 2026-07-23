import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  db: {
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    message: {
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    taskStatusEvent: {
      create: vi.fn(),
    },
    ptySession: {
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("./hub", () => ({
  realtimeHub: {
    register: vi.fn(),
    takeOverAgentHost: vi.fn().mockReturnValue(0),
    heartbeat: vi.fn(),
    bindTaskToAgent: vi.fn(),
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    recordTerminalLatencySample: vi.fn(),
    hasAgentHost: vi.fn().mockReturnValue(false),
    getAgentsForUser: vi.fn().mockReturnValue([]),
    isTerminalAttached: vi.fn().mockReturnValue(true),
    sendToConnection: vi.fn().mockReturnValue(true),
    broadcastTerminal: vi.fn(),
    broadcast: vi.fn(),
    notifyTaskStatus: vi.fn(),
    resolveAiManagerResponse: vi.fn(),
    resolveCustomCommandsResponse: vi.fn(),
  },
}));

vi.mock("../auth/service", () => ({
  authenticateToken: vi.fn(),
}));

vi.mock("./agent-upstream", () => ({
  commitAgentCommandAck: vi.fn(),
  commitSdkMessage: vi.fn(),
  commitTaskStopAck: vi.fn(),
  commitTaskStatusUpdate: vi.fn(),
  drainAgentOutboxForHost: vi.fn().mockResolvedValue({ attempted: 0, delivered: 0 }),
}));

const { db } = await import("../db");
const { realtimeHub } = await import("./hub");
const { authenticateToken } = await import("../auth/service");
const { commitTaskStatusUpdate, drainAgentOutboxForHost } = await import("./agent-upstream");
const {
  bindActiveTasksFromResume,
  ensureAgentOwnsTask,
  handlePtyTransportSignalEvent,
  handlePtyTransportStatusEvent,
  handleTerminalErrorEvent,
  handleTerminalExitEvent,
  handleTerminalOutputEvent,
  handleTerminalSnapshotEvent,
  processAgentResume,
  setupAgentGateway,
} = await import("./agent-gateway");

const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe("agent-gateway ownership handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.takeOverAgentHost).mockReturnValue(0);
    vi.mocked(realtimeHub.isTerminalAttached).mockReturnValue(true);
    vi.mocked(authenticateToken).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(null as any);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(db.task.update).mockResolvedValue({} as any);
    vi.mocked(db.task.create).mockResolvedValue({} as any);
    vi.mocked(db.message.create).mockResolvedValue({} as any);
    vi.mocked(db.user.findUnique).mockResolvedValue({ subscriptionTier: "PLUS" } as any);
    vi.mocked(db.taskStatusEvent.create).mockResolvedValue({} as any);
    vi.mocked(db.ptySession.update).mockResolvedValue({} as any);
    vi.mocked(db.$transaction).mockImplementation(async (operations: any) => {
      if (Array.isArray(operations)) {
        return Promise.all(operations);
      }
      return operations;
    });
  });

  it("bumps task activity when agent create_task includes prefill", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }

    const socket = new FakeSocket();
    vi.mocked(db.task.create).mockResolvedValue({
      id: "task-prefill-1",
      projectId: "proj-1",
      title: "Prefill Task",
    } as any);
    vi.mocked(db.message.create).mockResolvedValue({
      id: "msg-prefill-1",
      taskId: "task-prefill-1",
      role: "user",
      content: "hello from prefill",
      createdAt: new Date("2026-03-24T00:00:00.000Z"),
    } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-prefill-1",
      updatedAt: new Date("2026-03-24T00:00:00.000Z"),
    } as any);

    const wss = setupAgentGateway();
    const request = {
      headers: {
        authorization: "Bearer test-token",
        "x-conductor-host": "daemon-a",
        "x-conductor-backends": "codex",
        "x-conductor-backend-runtime-map": "codex-gamma=codex,codex=codex",
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    } as any;

    wss.emit("connection", socket as any, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "create_task",
      payload: {
        task_id: "task-prefill-1",
        project_id: "proj-1",
        title: "Prefill Task",
        prefill: "hello from prefill",
      },
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(db.message.create).toHaveBeenCalledWith({
      data: {
        taskId: "task-prefill-1",
        role: "user",
        content: "hello from prefill",
      },
    });
    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-prefill-1" },
      data: { updatedAt: expect.any(Date) },
    });
    expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "proj-1", {
      type: "task_user_message",
      payload: expect.objectContaining({
        id: "msg-prefill-1",
        task_id: "task-prefill-1",
        content: "hello from prefill",
      }),
    });
  });

  it("takes over an existing same-host connection instead of rejecting duplicate-host", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }

    const socket = new FakeSocket();
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.takeOverAgentHost).mockReturnValue(1);

    const wss = setupAgentGateway();
    const request = {
      headers: {
        authorization: "Bearer test-token",
        "x-conductor-host": "daemon-a",
        "x-conductor-backends": "codex",
        "x-conductor-backend-runtime-map": "codex-gamma=codex,codex=codex",
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    } as any;

    wss.emit("connection", socket as any, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(realtimeHub.takeOverAgentHost).toHaveBeenCalledWith("daemon-a", "user-1");
    expect(realtimeHub.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agent",
        userId: "user-1",
        host: "daemon-a",
        runtimeBackendMap: {
          "codex-gamma": "codex",
          codex: "codex",
        },
      }),
    );
    expect(socket.close).not.toHaveBeenCalledWith(4002, "duplicate-host");
  });

  it("only rebinds resumed tasks that are actively assigned to the reconnecting host", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([
      { id: "task-daemon-owned", agentHost: "daemon-a", executionHost: "daemon-a", status: "running" },
      { id: "task-pending-owned", agentHost: "daemon-a", executionHost: null, status: "unknown" },
      { id: "task-other-host", agentHost: "daemon-b", executionHost: "daemon-b", status: "running" },
      { id: "task-completed", agentHost: "daemon-a", executionHost: "daemon-a", status: "completed" },
    ] as any);

    const boundCount = await bindActiveTasksFromResume("user-1", "daemon-a", [
      "task-daemon-owned",
      "task-pending-owned",
      "task-other-host",
      "task-completed",
    ]);

    expect(boundCount).toBe(2);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenNthCalledWith(1, "task-daemon-owned", "daemon-a");
    expect(realtimeHub.bindTaskToAgent).toHaveBeenNthCalledWith(2, "task-pending-owned", "daemon-a");
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["task-daemon-owned", "task-pending-owned"] },
        project: { userId: "user-1" },
        OR: [
          { executionHost: null },
          { executionHost: { not: "daemon-a" } },
        ],
      },
      data: { executionHost: "daemon-a" },
    });
  });

  it("still drains outbox after processing a daemon resume", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([
      { id: "task-pty-1", agentHost: "daemon-reconnected", executionHost: "daemon-reconnected", status: "running" },
    ] as any);

    const result = await processAgentResume({
      userId: "user-1",
      agentHost: "daemon-reconnected",
      payload: {
        source: "conductor-daemon",
        active_tasks: ["task-pty-1"],
      },
    });

    expect(result).toEqual({
      boundCount: 1,
      source: "conductor-daemon",
    });
    expect(drainAgentOutboxForHost).toHaveBeenCalledWith("user-1", "daemon-reconnected", {
      ignoreRetryAt: true,
    });
  });

  it("falls back to legacy resume binding when task_type column is missing", async () => {
    vi.mocked(db.task.findMany)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.task_type` does not exist in the current database.'),
      )
      .mockResolvedValueOnce([
        { id: "task-legacy-1", agentHost: "daemon-a", executionHost: "daemon-a", status: "running" },
      ] as any);

    const boundCount = await bindActiveTasksFromResume("user-1", "daemon-a", ["task-legacy-1"]);

    expect(boundCount).toBe(1);
    expect(db.task.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          agentHost: true,
          executionHost: true,
          status: true,
        }),
      }),
    );
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-legacy-1", "daemon-a");
  });

  it("allows conductor-fire hosts to rebind daemon-owned ai tasks on resume", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([
      {
        id: "task-ai-1",
        taskType: "ai_task",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        status: "running",
      },
      {
        id: "task-pty-1",
        taskType: "pty_task",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        status: "running",
      },
    ] as any);

    const boundCount = await bindActiveTasksFromResume("user-1", "conductor-fire-mac-1", [
      "task-ai-1",
      "task-pty-1",
    ]);

    expect(boundCount).toBe(1);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledTimes(1);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-ai-1", "conductor-fire-mac-1");
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["task-ai-1"] },
        project: { userId: "user-1" },
        OR: [
          { executionHost: null },
          { executionHost: { not: "conductor-fire-mac-1" } },
        ],
      },
      data: { executionHost: "conductor-fire-mac-1" },
    });
  });

  it("rejects agent ownership claims when the task is assigned to a different host", async () => {
    await expect(
      ensureAgentOwnsTask(
        "user-1",
        {
          id: "task-1",
          agentHost: "daemon-a",
          executionHost: "daemon-b",
        },
        "daemon-a",
      ),
    ).rejects.toThrow("Task task-1 is assigned to daemon-b, not daemon-a");
  });

  it("allows conductor-fire hosts to claim daemon-owned ai tasks", async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-a");
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);

    await expect(
      ensureAgentOwnsTask(
        "user-1",
        {
          id: "task-ai-1",
          taskType: "ai_task",
          agentHost: "daemon-a",
          executionHost: "daemon-a",
        },
        "conductor-fire-mac-1",
      ),
    ).resolves.toBeUndefined();

    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-ai-1", "conductor-fire-mac-1");
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-ai-1",
        project: { userId: "user-1" },
        OR: [
          { executionHost: null },
          { executionHost: { not: "conductor-fire-mac-1" } },
        ],
      },
      data: { executionHost: "conductor-fire-mac-1" },
    });
  });

  it("allows conductor-fire hosts to repair stale daemon bindings when executionHost already points to fire", async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-a");
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);

    await expect(
      ensureAgentOwnsTask(
        "user-1",
        {
          id: "task-ai-1",
          taskType: "ai_task",
          agentHost: "daemon-a",
          executionHost: "conductor-fire-mac-1",
        },
        "conductor-fire-mac-1",
      ),
    ).resolves.toBeUndefined();

    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-ai-1", "conductor-fire-mac-1");
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-ai-1",
        project: { userId: "user-1" },
        OR: [
          { executionHost: null },
          { executionHost: { not: "conductor-fire-mac-1" } },
        ],
      },
      data: { executionHost: "conductor-fire-mac-1" },
    });
  });

  it("forwards the agent's status_event_id so redelivery can be deduped", async () => {
    // Regression: this handler used to drop `status_event_id`, which made the
    // field dead weight on the wire. The server then synthesized a fresh id
    // per delivery, so a redelivered transition became a second event row and
    // a second broadcast instead of being recognised as a duplicate.
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }

    const socket = new FakeSocket();
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-evt-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "debug",
      executionHost: "debug",
    } as any);
    vi.mocked(commitTaskStatusUpdate).mockResolvedValue({
      taskId: "task-evt-1",
      projectId: "proj-1",
      status: "killed",
      duplicate: false,
    } as any);

    const wss = setupAgentGateway();
    wss.emit("connection", socket as any, {
      headers: {
        authorization: "Bearer test-token",
        "x-conductor-host": "debug",
      },
      socket: { remoteAddress: "127.0.0.1" },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "task_status_update",
      payload: {
        task_id: "task-evt-1",
        status: "killed",
        summary: "new task failed: EEXIST",
        status_event_id: "evt-from-daemon-1",
      },
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commitTaskStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-evt-1",
        status: "killed",
        summary: "new task failed: EEXIST",
        statusEventId: "evt-from-daemon-1",
      }),
    );
  });

  it("promotes init tasks to running when runtime status arrives from a fire host", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }

    const socket = new FakeSocket();
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-init-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "init",
      agentHost: "debug",
      executionHost: null,
    } as any);

    const wss = setupAgentGateway();
    const request = {
      headers: {
        authorization: "Bearer test-token",
        "x-conductor-host": "conductor-fire-debug-123",
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    } as any;

    wss.emit("connection", socket as any, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "task_runtime_status",
      payload: {
        task_id: "task-init-1",
        phase: "session_started",
        session_id: "session-1",
      },
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commitTaskStatusUpdate).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "conductor-fire-debug-123",
      taskId: "task-init-1",
      status: "running",
    });
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_runtime_status",
        payload: expect.objectContaining({
          task_id: "task-init-1",
          session_id: "session-1",
        }),
      }),
    );
  });

  it("drops terminal output from stale daemons when another host owns the binding", async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-live");

    await handleTerminalOutputEvent({
      userId: "user-1",
      agentHost: "daemon-stale",
      payload: {
        task_id: "task-pty-1",
        seq: 42,
        data: "stale output",
      },
    });

    expect(db.task.findFirst).not.toHaveBeenCalled();
    expect(realtimeHub.broadcastTerminal).not.toHaveBeenCalled();
  });

  it("rebinds terminal output only when the persisted owner host matches the sender", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-pty-2",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
    } as any);

    await handleTerminalOutputEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-2",
        seq: 7,
        data: "hello",
        latency_sample: {
          client_input_seq: 3,
          client_sent_at: "2026-03-17T01:00:00.000Z",
          server_received_at: "2026-03-17T01:00:00.010Z",
          daemon_received_at: "2026-03-17T01:00:00.020Z",
          first_output_at: "2026-03-17T01:00:00.040Z",
          daemon_input_to_first_output_ms: 20,
        },
      },
    });

    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-pty-2", "daemon-a");
    expect(realtimeHub.recordTerminalLatencySample).toHaveBeenCalledWith("task-pty-2", {
      client_input_seq: 3,
      client_sent_at: "2026-03-17T01:00:00.000Z",
      server_received_at: "2026-03-17T01:00:00.010Z",
      daemon_received_at: "2026-03-17T01:00:00.020Z",
      first_output_at: "2026-03-17T01:00:00.040Z",
      daemon_input_to_first_output_ms: 20,
    });
    expect(realtimeHub.broadcastTerminal).toHaveBeenCalledWith("user-1", "task-pty-2", {
      type: "terminal_output",
      payload: {
        task_id: "task-pty-2",
        project_id: undefined,
        pty_session_id: undefined,
        seq: 7,
        data: "hello",
        latency_sample: {
          client_input_seq: 3,
          client_sent_at: "2026-03-17T01:00:00.000Z",
          server_received_at: "2026-03-17T01:00:00.010Z",
          daemon_received_at: "2026-03-17T01:00:00.020Z",
          first_output_at: "2026-03-17T01:00:00.040Z",
          daemon_input_to_first_output_ms: 20,
        },
      },
    });
  });

  it("routes terminal snapshots to the requesting connection after ownership validation", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-pty-snapshot",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
    } as any);

    await handleTerminalSnapshotEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-snapshot",
        connection_id: "conn-app-1",
        last_seq: 12,
        data: "recent tail",
        truncated: true,
      },
    });

    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-pty-snapshot", "daemon-a");
    expect(realtimeHub.sendToConnection).toHaveBeenCalledWith("conn-app-1", {
      type: "terminal_snapshot",
      payload: {
        task_id: "task-pty-snapshot",
        project_id: undefined,
        pty_session_id: undefined,
        last_seq: 12,
        data: "recent tail",
        truncated: true,
      },
    });
    expect(realtimeHub.broadcastTerminal).not.toHaveBeenCalled();
  });

  it("treats numeric exit signals as killed terminal exits", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-pty-3",
      projectId: "proj-1",
      taskType: "pty_task",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      ptySession: {
        id: "pty-3",
      },
    } as any);

    await handleTerminalExitEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-3",
        seq: 11,
        exit_code: 0,
        signal: 9,
        closed_at: "2026-03-11T08:00:00.000Z",
      },
    });

    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-pty-3" },
      data: { status: "killed", executionHost: "daemon-a" },
    });
    expect(realtimeHub.broadcastTerminal).toHaveBeenCalledWith("user-1", "task-pty-3", {
      type: "terminal_exit",
      payload: {
        task_id: "task-pty-3",
        project_id: "proj-1",
        pty_session_id: "pty-3",
        exit_code: 0,
        signal: "9",
        seq: 11,
        closed_at: "2026-03-11T08:00:00.000Z",
      },
    });
  });

  it("persists terminal error summaries for later diagnosis", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-pty-err-1",
      projectId: "proj-1",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      ptySession: {
        id: "pty-err-1",
      },
      taskStatusEvents: [],
    } as any);

    await handleTerminalErrorEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-err-1",
        message: "spawn-helper missing execute bit",
      },
    });

    expect(db.taskStatusEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: "task-pty-err-1",
        status: "killed",
        summary: "spawn-helper missing execute bit",
      }),
    });
    expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "proj-1", {
      type: "task_status_update",
      payload: {
        task_id: "task-pty-err-1",
        project_id: "proj-1",
        status: "killed",
        summary: "spawn-helper missing execute bit",
      },
    });
  });

  it("skips duplicate terminal error summaries for the same active task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-pty-err-dup-1",
      projectId: "proj-1",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      ptySession: {
        id: "pty-err-dup-1",
      },
      taskStatusEvents: [
        {
          status: "killed",
          summary: "spawn-helper missing execute bit",
        },
      ],
    } as any);

    await handleTerminalErrorEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-err-dup-1",
        message: "spawn-helper missing execute bit",
      },
    });

    expect(db.taskStatusEvent.create).not.toHaveBeenCalled();
    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-pty-err-dup-1" },
      data: { status: "killed", executionHost: "daemon-a" },
    });
    expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "proj-1", {
      type: "task_status_update",
      payload: {
        task_id: "task-pty-err-dup-1",
        project_id: "proj-1",
        status: "killed",
        summary: "spawn-helper missing execute bit",
      },
    });
  });

  it("skips terminal error persistence once the task is already final", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-pty-err-final-1",
      projectId: "proj-1",
      taskType: "pty_task",
      status: "killed",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      ptySession: {
        id: "pty-err-final-1",
      },
      taskStatusEvents: [
        {
          status: "killed",
          summary: "previous failure",
        },
      ],
    } as any);

    await handleTerminalErrorEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-err-final-1",
        message: "spawn-helper missing execute bit",
      },
    });

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.taskStatusEvent.create).not.toHaveBeenCalled();
    expect(db.task.update).not.toHaveBeenCalled();
    expect(db.ptySession.update).not.toHaveBeenCalled();
    expect(realtimeHub.broadcast).not.toHaveBeenCalled();
    expect(realtimeHub.broadcastTerminal).toHaveBeenCalledWith("user-1", "task-pty-err-final-1", {
      type: "terminal_error",
      payload: {
        task_id: "task-pty-err-final-1",
        project_id: "proj-1",
        pty_session_id: "pty-err-final-1",
        message: "spawn-helper missing execute bit",
        closed_at: expect.any(String),
      },
    });
  });

  it("ignores terminal exit events when PTY schema is missing", async () => {
    vi.mocked(db.task.findFirst).mockRejectedValueOnce(
      prismaError("P2021", "The table `pty_sessions` does not exist in the current database."),
    );

    await expect(
      handleTerminalExitEvent({
        userId: "user-1",
        agentHost: "daemon-a",
        payload: {
          task_id: "task-legacy-pty",
          exit_code: 0,
        },
      }),
    ).resolves.toBeUndefined();

    expect(db.task.update).not.toHaveBeenCalled();
    expect(realtimeHub.broadcastTerminal).not.toHaveBeenCalled();
  });

  it("forwards PTY transport status events to the originating app connection", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-pty-rtc-1",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
    } as any);

    await handlePtyTransportStatusEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-rtc-1",
        session_id: "transport-1",
        connection_id: "conn-app-1",
        transport_state: "fallback_relay",
        reason: "direct_transport_not_supported",
      },
    });

    expect(realtimeHub.sendToConnection).toHaveBeenCalledWith("conn-app-1", {
      type: "pty_transport_status",
      payload: {
        task_id: "task-pty-rtc-1",
        session_id: "transport-1",
        transport_state: "fallback_relay",
        transport_policy: undefined,
        writer_connection_id: undefined,
        direct_candidate: false,
        reason: "direct_transport_not_supported",
      },
    });
  });

  it("forwards PTY transport signals to the originating app connection", async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-a");

    await handlePtyTransportSignalEvent({
      userId: "user-1",
      agentHost: "daemon-a",
      payload: {
        task_id: "task-pty-rtc-2",
        session_id: "transport-2",
        connection_id: "conn-app-2",
        signal_type: "answer",
        description: {
          type: "answer",
          sdp: "v=0",
        },
      },
    });

    expect(realtimeHub.sendToConnection).toHaveBeenCalledWith("conn-app-2", {
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-rtc-2",
        session_id: "transport-2",
        signal_type: "answer",
        description: {
          type: "answer",
          sdp: "v=0",
        },
      },
    });
  });

  it("ai_manager_response forwards user.id + agentHost to the hub on resolve", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }
    const socket = new FakeSocket();
    const wss = setupAgentGateway();
    const request = {
      headers: { authorization: "Bearer test-token", "x-conductor-host": "daemon-aim" },
      socket: { remoteAddress: "127.0.0.1" },
    } as any;

    wss.emit("connection", socket as any, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "ai_manager_response",
          payload: {
            request_id: "req-aim-1",
            action: "status",
            result: { ok: true },
            error: null,
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(realtimeHub.resolveAiManagerResponse).toHaveBeenCalledWith(
      {
        request_id: "req-aim-1",
        action: "status",
        result: { ok: true },
        error: null,
      },
      "user-1",
      "daemon-aim",
    );
  });

  it("ai_manager_response with missing request_id sends an error envelope and does not resolve", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }
    const socket = new FakeSocket();
    const wss = setupAgentGateway();
    const request = {
      headers: { authorization: "Bearer test-token", "x-conductor-host": "daemon-aim-2" },
      socket: { remoteAddress: "127.0.0.1" },
    } as any;

    wss.emit("connection", socket as any, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "ai_manager_response",
          payload: { action: "status", result: { ok: true } },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(realtimeHub.resolveAiManagerResponse).not.toHaveBeenCalled();
    const errorSends = (socket.send as any).mock.calls.filter((call: any[]) => {
      try {
        return JSON.parse(String(call[0])).type === "error";
      } catch {
        return false;
      }
    });
    expect(errorSends.length).toBeGreaterThan(0);
    const lastError = JSON.parse(String(errorSends[errorSends.length - 1][0]));
    expect(lastError.payload.message).toMatch(/request_id/);
  });

  it("custom_commands_response forwards user.id + agentHost to the hub on resolve", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }
    const socket = new FakeSocket();
    const wss = setupAgentGateway();
    const request = {
      headers: { authorization: "Bearer test-token", "x-conductor-host": "daemon-commands" },
      socket: { remoteAddress: "127.0.0.1" },
    } as any;

    wss.emit("connection", socket as any, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "custom_commands_response",
          payload: {
            request_id: "req-command-1",
            action: "list",
            result: { commands: [{ key: "refresh-cache" }] },
            error: null,
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(realtimeHub.resolveCustomCommandsResponse).toHaveBeenCalledWith(
      {
        request_id: "req-command-1",
        action: "list",
        result: { commands: [{ key: "refresh-cache" }] },
        error: null,
      },
      "user-1",
      "daemon-commands",
    );
  });

  it("custom_commands_response with missing request_id sends an error envelope and does not resolve", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }
    const socket = new FakeSocket();
    const wss = setupAgentGateway();
    const request = {
      headers: { authorization: "Bearer test-token", "x-conductor-host": "daemon-commands-2" },
      socket: { remoteAddress: "127.0.0.1" },
    } as any;

    wss.emit("connection", socket as any, request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "custom_commands_response",
          payload: { action: "list", result: { commands: [] } },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(realtimeHub.resolveCustomCommandsResponse).not.toHaveBeenCalled();
    const errorSends = (socket.send as any).mock.calls.filter((call: any[]) => {
      try {
        return JSON.parse(String(call[0])).type === "error";
      } catch {
        return false;
      }
    });
    expect(errorSends.length).toBeGreaterThan(0);
    const lastError = JSON.parse(String(errorSends[errorSends.length - 1][0]));
    expect(lastError.payload.message).toMatch(/request_id/);
  });
});

// RFC 0029: processAgentAliveTasks must (a) only touch
// killed/daemon_disconnected rows, (b) not clobber agentHost/executionHost,
// and (c) skip the in-memory rebind for manual-fire tasks so sdk_message
// continues to flow to the fire ws.
describe("processAgentAliveTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes killed flags but leaves agentHost/executionHost untouched for pure-daemon tasks", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([
      { id: "task-d1", projectId: "proj-1", agentHost: "daemon-Y" },
    ] as any);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 1 } as any);

    const { processAgentAliveTasks } = await import("./agent-gateway");
    const result = await processAgentAliveTasks({
      userId: "user-1",
      agentHost: "daemon-Y",
      payload: {
        agent_host: "daemon-Y",
        alive_task_ids: ["task-d1"],
        reason: "agent_reconnect",
      },
    });

    expect(result.revokedTaskIds).toEqual(["task-d1"]);
    expect(result.consideredCount).toBe(1);
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-d1",
        status: "killed",
        killedReason: "daemon_disconnected",
      },
      data: {
        status: "running",
        killedReason: null,
        killedAt: null,
        // Critically: no executionHost / agentHost writes.
      },
    });
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-d1", "daemon-Y");
  });

  it("does NOT rebind the realtime hub for manual-fire tasks (agentHost != calling daemon)", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([
      {
        id: "task-mf1",
        projectId: "proj-1",
        // Manual-fire task: logical owner is daemon-Y, executor is fire-X.
        // The push came in via daemon-Y (executionHost match path).
        agentHost: "conductor-fire-X",
      },
    ] as any);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 1 } as any);

    const { processAgentAliveTasks } = await import("./agent-gateway");
    const result = await processAgentAliveTasks({
      userId: "user-1",
      agentHost: "daemon-Y",
      payload: {
        agent_host: "daemon-Y",
        alive_task_ids: ["task-mf1"],
        reason: "agent_reconnect",
      },
    });

    expect(result.revokedTaskIds).toEqual(["task-mf1"]);
    // The hub must not be re-bound to daemon-Y, otherwise sdk_message would
    // route to the daemon ws (which cannot relay into a detached in-tmux
    // fire) instead of to the fire's own ws.
    expect(realtimeHub.bindTaskToAgent).not.toHaveBeenCalled();
  });

  it("ignores empty payloads without touching the DB", async () => {
    const { processAgentAliveTasks } = await import("./agent-gateway");
    const result = await processAgentAliveTasks({
      userId: "user-1",
      agentHost: "daemon-Y",
      payload: { agent_host: "daemon-Y", alive_task_ids: [] },
    });

    expect(result).toEqual({
      revokedTaskIds: [],
      consideredCount: 0,
      reason: "agent_reconnect",
    });
    expect(db.task.findMany).not.toHaveBeenCalled();
    expect(db.task.updateMany).not.toHaveBeenCalled();
  });

  it("returns gracefully when the killedReason column is missing (pre-migration DB)", async () => {
    vi.mocked(db.task.findMany).mockRejectedValue(
      prismaError("P2022", "Column `tasks.killed_reason` does not exist"),
    );
    const { processAgentAliveTasks } = await import("./agent-gateway");
    const result = await processAgentAliveTasks({
      userId: "user-1",
      agentHost: "daemon-Y",
      payload: { agent_host: "daemon-Y", alive_task_ids: ["task-x"] },
    });
    expect(result.revokedTaskIds).toEqual([]);
    expect(result.consideredCount).toBe(1);
    expect(db.task.updateMany).not.toHaveBeenCalled();
  });
});
