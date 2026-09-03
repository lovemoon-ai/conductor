import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
    waitForBackendSessions: vi.fn(),
    cancelBackendSessions: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

const { realtimeHub } = await import("@/lib/realtime/hub");
const { listBackendSessions } = await import("@/lib/agents/backend-sessions");

const onlineAgent = (capabilities: string[] = ["backend_session_list"]) => ({
  host: "daemon-a",
  capabilities,
});

describe("listBackendSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([onlineAgent()] as never);
    vi.mocked(realtimeHub.waitForBackendSessions).mockResolvedValue({
      request_id: "req-1",
      sessions: [],
      errors: [],
    });
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
  });

  it("sends a payload-wrapped list_backend_sessions envelope (daemon wire contract)", async () => {
    const outcome = await listBackendSessions({
      userId: "user-1",
      agentHost: "daemon-a",
      backends: ["claude", "codex"],
      limit: 30,
    });

    expect(outcome.ok).toBe(true);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledTimes(1);
    const [userId, agentHost, message] = vi.mocked(realtimeHub.sendToAgentHost).mock.calls[0];
    expect(userId).toBe("user-1");
    expect(agentHost).toBe("daemon-a");
    // The daemon dispatches on `event.payload`; a flat message is silently dropped.
    expect(message).toEqual({
      type: "list_backend_sessions",
      payload: {
        request_id: expect.any(String),
        backends: ["claude", "codex"],
        limit: 30,
      },
    });
    expect(realtimeHub.waitForBackendSessions).toHaveBeenCalledWith(
      (message as { payload: { request_id: string } }).payload.request_id,
      expect.any(Number),
    );
  });

  it("omits backends/limit from the payload when not provided", async () => {
    await listBackendSessions({ userId: "user-1", agentHost: "daemon-a" });
    const [, , message] = vi.mocked(realtimeHub.sendToAgentHost).mock.calls[0];
    expect(message).toEqual({
      type: "list_backend_sessions",
      payload: { request_id: expect.any(String) },
    });
  });

  it("returns daemon_offline when the host is not connected", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([] as never);
    const outcome = await listBackendSessions({ userId: "user-1", agentHost: "daemon-a" });
    expect(outcome).toEqual({ ok: false, reason: "daemon_offline" });
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("returns capability_missing for daemons without backend_session_list", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([onlineAgent(["pty_task"])] as never);
    const outcome = await listBackendSessions({ userId: "user-1", agentHost: "daemon-a" });
    expect(outcome).toEqual({ ok: false, reason: "capability_missing" });
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("cancels the waiter and reports daemon_offline when the send fails", async () => {
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(false);
    const outcome = await listBackendSessions({ userId: "user-1", agentHost: "daemon-a" });
    expect(outcome).toEqual({ ok: false, reason: "daemon_offline" });
    expect(realtimeHub.cancelBackendSessions).toHaveBeenCalledTimes(1);
  });

  it("returns timeout when the waiter resolves null", async () => {
    vi.mocked(realtimeHub.waitForBackendSessions).mockResolvedValue(null);
    const outcome = await listBackendSessions({ userId: "user-1", agentHost: "daemon-a" });
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
  });
});
