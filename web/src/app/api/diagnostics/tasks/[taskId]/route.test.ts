import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/diagnostics/tasks/[taskId]/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
    taskStatusEvent: {
      findFirst: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    agentOutbox: {
      findMany: vi.fn(),
    },
    taskDiagnosticsSnapshot: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn(),
    getTerminalLatencySample: vi.fn(),
    hasAgentHost: vi.fn(),
    getAgentDisconnectAt: vi.fn(),
    getAgentsForUser: vi.fn(),
    sendToAgentHost: vi.fn(),
    waitForAgentLogCollection: vi.fn(),
    cancelAgentLogCollection: vi.fn(),
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");

describe("/api/diagnostics/tasks/[taskId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.message.findMany).mockResolvedValue([]);
    vi.mocked(db.message.count).mockResolvedValue(0);
    vi.mocked(db.agentOutbox.findMany).mockResolvedValue([]);
    vi.mocked(db.taskStatusEvent.findFirst).mockResolvedValue(null);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.getTerminalLatencySample).mockReturnValue(null);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.getAgentDisconnectAt).mockReturnValue(null);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.waitForAgentLogCollection).mockResolvedValue(null);
    vi.mocked(realtimeHub.cancelAgentLogCollection).mockImplementation(() => {});
  });

  it("returns snapshot diagnostics when task is deleted", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null);
    vi.mocked(db.taskDiagnosticsSnapshot.findFirst).mockResolvedValue({
      payloadJson: JSON.stringify({
        task: {
          id: "task-1",
          project_id: "proj-1",
          title: "Task 1",
          status: "running",
          agent_host: "conductor-fire-host",
          latest_status_summary: null,
          latest_status_summary_created_at: null,
          created_at: "2026-03-05T12:00:00.000Z",
          updated_at: "2026-03-05T12:01:00.000Z",
        },
        realtime: {
          bound_agent_host: "conductor-fire-host",
          bound_agent_connected: true,
          bound_agent_is_fire: true,
          assigned_agent_host: "conductor-fire-host",
          assigned_agent_connected: true,
          assigned_agent_is_fire: true,
          assigned_agent_disconnect_at: null,
          bound_agent_disconnect_at: null,
          connected_fire_hosts: ["conductor-fire-host"],
          connected_agents: [],
        },
        pty_transport: {
          latest_latency_sample: null,
          primary_bottleneck: null,
        },
        messages: {
          sample_size: 200,
          sampled_count: 0,
          total_count: 0,
          latest_user: null,
          latest_sdk: null,
          latest_sdk_failure_key: null,
          latest_pending_user: null,
          has_pending_user: false,
          pending_user_count_in_sample: 0,
          pending_age_ms: null,
        },
        outbox: {
          available: true,
          error: null,
          sample_size: 100,
          sampled_count: 0,
          task_user_message_by_status: {},
          latest_for_pending_user: null,
          recent_task_user_messages: [],
        },
        diagnosis: {
          code: "no_pending_user",
          confidence: "high",
          summary: "snapshot",
          reasons: [],
          next_actions: [],
        },
      }),
      trigger: "task_delete",
      createdAt: new Date("2026-03-05T12:10:00.000Z"),
    } as any);

    const token = createTestToken("user-1");
    const request = createMockRequest({ token });
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-1" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.source).toBe("snapshot");
    expect(data.snapshot_trigger).toBe("task_delete");
    expect(data.task?.id).toBe("task-1");
  });

  it("returns 404 when task and snapshot are both missing", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null);
    vi.mocked(db.taskDiagnosticsSnapshot.findFirst).mockResolvedValue(null);

    const token = createTestToken("user-1");
    const request = createMockRequest({ token });
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-missing" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(404);
    expect(data.error).toBe("Task not found");
  });

  it("returns live diagnostics for existing task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-live",
      projectId: "proj-1",
      title: "Live Task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "conductor-fire-host",
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:01:00.000Z"),
    } as any);
    vi.mocked(db.taskDiagnosticsSnapshot.findFirst).mockResolvedValue(null);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-host");
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-daemon", host: "daemon-a", supportedBackends: ["codex"] },
      { id: "agent-1", host: "conductor-fire-host", supportedBackends: [] },
    ] as any);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.waitForAgentLogCollection).mockResolvedValue({
      request_id: "req-live",
      task_id: "task-live",
      daemon_host: "daemon-a",
      project_path: "/tmp/proj-1",
      log_path: "/tmp/proj-1/conductor.log",
      logs: [{ timestamp: "2026-03-05T12:00:30.000Z", level: "INFO", message: "runner started" }],
      truncated: false,
      error: null,
      collected_at: "2026-03-05T12:01:01.000Z",
    });
    vi.mocked(realtimeHub.getTerminalLatencySample).mockReturnValue({
      task_id: "task-live",
      client_input_seq: 5,
      client_sent_at: "2026-03-05T12:00:29.900Z",
      server_received_at: "2026-03-05T12:00:29.920Z",
      daemon_received_at: "2026-03-05T12:00:29.930Z",
      first_output_at: "2026-03-05T12:00:30.010Z",
      daemon_input_to_first_output_ms: 80,
      recorded_at: "2026-03-05T12:00:30.010Z",
    } as any);
    vi.mocked(db.taskStatusEvent.findFirst).mockResolvedValue({
      summary: "spawn-helper missing execute bit",
      createdAt: new Date("2026-03-05T12:00:59.000Z"),
    } as any);

    const token = createTestToken("user-1");
    const request = createMockRequest({ token });
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-live" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.source).toBe("live");
    expect(data.task?.id).toBe("task-live");
    expect(data.task?.latest_status_summary).toBe("spawn-helper missing execute bit");
    expect(data.task?.latest_status_summary_created_at).toBe("2026-03-05T12:00:59.000Z");
    expect(data.fire_logs?.daemon_host).toBe("daemon-a");
    expect(data.pty_transport?.latest_latency_sample).toMatchObject({
      task_id: "task-live",
      client_input_seq: 5,
      daemon_input_to_first_output_ms: 80,
      client_input_to_server_received_ms: 20,
      server_received_to_daemon_received_ms: 10,
      client_input_to_first_output_ms: 110,
    });
    expect(data.pty_transport?.primary_bottleneck).toBe("daemon_exec");
    expect(data.fire_logs?.entries).toEqual([
      { timestamp: "2026-03-05T12:00:30.000Z", level: "INFO", message: "runner started" },
    ]);
  });

  it("uses task metadata daemonName to collect logs for manual fire tasks", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-manual-fire",
      projectId: "proj-1",
      title: "Manual Fire Task",
      status: "running",
      agentHost: "conductor-fire-host-1",
      executionHost: "conductor-fire-host-1",
      metadata: JSON.stringify({ daemonName: "daemon-a" }),
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:01:00.000Z"),
    } as any);
    vi.mocked(db.taskDiagnosticsSnapshot.findFirst).mockResolvedValue(null);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-host-1");
    vi.mocked(realtimeHub.hasAgentHost).mockImplementation((host) => host === "daemon-a" || host === "conductor-fire-host-1");
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-daemon", host: "daemon-a", supportedBackends: ["codex"] },
      { id: "agent-fire", host: "conductor-fire-host-1", supportedBackends: ["codex"] },
    ] as any);
    vi.mocked(realtimeHub.sendToAgentHost).mockImplementation((_userId, host) => host === "daemon-a");
    vi.mocked(realtimeHub.waitForAgentLogCollection).mockResolvedValue({
      request_id: "req-manual-fire",
      task_id: "task-manual-fire",
      daemon_host: "daemon-a",
      project_path: "/tmp/proj-manual-fire",
      log_path: "/tmp/proj-manual-fire/conductor.log",
      logs: [{ timestamp: "2026-03-05T12:00:31.000Z", level: "INFO", message: "manual fire attached" }],
      truncated: false,
      error: null,
      collected_at: "2026-03-05T12:01:01.000Z",
    });

    const token = createTestToken("user-1");
    const request = createMockRequest({ token });
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-manual-fire" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.source).toBe("live");
    expect(data.fire_logs?.daemon_host).toBe("daemon-a");
    expect(vi.mocked(realtimeHub.sendToAgentHost)).toHaveBeenCalledWith(
      "user-1",
      "daemon-a",
      expect.objectContaining({
        type: "collect_logs",
      }),
    );
  });

  it("falls back past stale daemon hints to another online daemon", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-fallback-daemon",
      projectId: "proj-1",
      title: "Fallback Task",
      status: "running",
      agentHost: "conductor-fire-host-1",
      executionHost: "conductor-fire-host-1",
      metadata: JSON.stringify({ daemonName: "daemon-stale" }),
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:01:00.000Z"),
    } as any);
    vi.mocked(db.taskDiagnosticsSnapshot.findFirst).mockResolvedValue(null);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-host-1");
    vi.mocked(realtimeHub.hasAgentHost).mockImplementation((host) => host === "daemon-live" || host === "conductor-fire-host-1");
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-stale", host: "daemon-stale", supportedBackends: ["codex"] },
      { id: "agent-live", host: "daemon-live", supportedBackends: ["codex"] },
      { id: "agent-fire", host: "conductor-fire-host-1", supportedBackends: ["codex"] },
    ] as any);
    vi.mocked(realtimeHub.sendToAgentHost).mockImplementation((_userId, host) => host === "daemon-live");
    vi.mocked(realtimeHub.waitForAgentLogCollection).mockResolvedValue({
      request_id: "req-fallback",
      task_id: "task-fallback-daemon",
      daemon_host: "daemon-live",
      project_path: "/tmp/proj-fallback",
      log_path: "/tmp/proj-fallback/conductor.log",
      logs: [{ timestamp: "2026-03-05T12:00:32.000Z", level: "INFO", message: "fallback hit live daemon" }],
      truncated: false,
      error: null,
      collected_at: "2026-03-05T12:01:02.000Z",
    });

    const token = createTestToken("user-1");
    const request = createMockRequest({ token });
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-fallback-daemon" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.fire_logs?.daemon_host).toBe("daemon-live");
    expect(vi.mocked(realtimeHub.sendToAgentHost)).toHaveBeenCalledWith(
      "user-1",
      "daemon-live",
      expect.objectContaining({ type: "collect_logs" }),
    );
  });
});
