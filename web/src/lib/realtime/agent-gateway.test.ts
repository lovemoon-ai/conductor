import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  db: {
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
    bindTaskToAgent: vi.fn(),
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    recordTerminalLatencySample: vi.fn(),
    hasAgentHost: vi.fn().mockReturnValue(false),
    isTerminalAttached: vi.fn().mockReturnValue(true),
    sendToConnection: vi.fn().mockReturnValue(true),
    broadcastTerminal: vi.fn(),
    broadcast: vi.fn(),
    notifyTaskStatus: vi.fn(),
  },
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
const { drainAgentOutboxForHost } = await import("./agent-upstream");
const {
  bindActiveTasksFromResume,
  ensureAgentOwnsTask,
  handlePtyTransportSignalEvent,
  handlePtyTransportStatusEvent,
  handleTerminalErrorEvent,
  handleTerminalExitEvent,
  handleTerminalOutputEvent,
  processAgentResume,
} = await import("./agent-gateway");

const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe("agent-gateway ownership handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.isTerminalAttached).mockReturnValue(true);
    vi.mocked(db.task.findFirst).mockResolvedValue(null as any);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(db.task.update).mockResolvedValue({} as any);
    vi.mocked(db.taskStatusEvent.create).mockResolvedValue({} as any);
    vi.mocked(db.ptySession.update).mockResolvedValue({} as any);
    vi.mocked(db.$transaction).mockResolvedValue([] as any);
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
        executionHost: { not: "daemon-a" },
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
        executionHost: { not: "conductor-fire-mac-1" },
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
        executionHost: { not: "conductor-fire-mac-1" },
      },
      data: { executionHost: "conductor-fire-mac-1" },
    });
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
});
