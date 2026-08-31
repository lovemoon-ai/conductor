import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/daemon-update", () => ({
  requestDaemonUpdate: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestDaemonUpdate } = await import("@/lib/realtime/daemon-update");

const authedUser = { id: "user-1", email: "test@example.com", phone: null } as any;
const paramsFor = (host: string) => ({ params: Promise.resolve({ host }) });

const updatableAgent = (host: string) => ({
  id: `agent-${host}`,
  host,
  supportedBackends: ["codex"],
  capabilities: ["update_daemon"],
});

describe("/api/agents/[host]/update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue(authedUser);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([updatableAgent("daemon-a")] as any);
    vi.mocked(requestDaemonUpdate).mockResolvedValue({
      ok: true,
      action: "start",
      result: { runId: "run-1", status: "running" },
    });
  });

  it("passes an unauthenticated response through", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }) as any,
    );
    const res = await POST(createMockRequest({ method: "POST" }), paramsFor("daemon-a"));

    expect(res.status).toBe(401);
    expect(requestDaemonUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the daemon is not connected", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    const res = await POST(createMockRequest({ method: "POST" }), paramsFor("daemon-a"));

    expect(res.status).toBe(404);
    expect(requestDaemonUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 when the daemon predates built-in update", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-old", host: "daemon-a", supportedBackends: [], capabilities: ["restart_daemon"] },
    ] as any);
    const res = await POST(createMockRequest({ method: "POST" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/built-in update/);
    expect(requestDaemonUpdate).not.toHaveBeenCalled();
  });

  it("starts an update on POST", async () => {
    const res = await POST(createMockRequest({ method: "POST" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data).toEqual({ runId: "run-1", status: "running" });
    expect(requestDaemonUpdate).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "daemon-a",
      action: "start",
    });
  });

  it("reads progress on GET", async () => {
    vi.mocked(requestDaemonUpdate).mockResolvedValue({
      ok: true,
      action: "status",
      result: { runId: "run-1", status: "completed", message: "Updated 1.0.0 → 1.1.0" },
    });
    const res = await GET(createMockRequest({ method: "GET" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe("completed");
    expect(requestDaemonUpdate).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "daemon-a",
      action: "status",
    });
  });

  it("surfaces a daemon-side refusal as 502", async () => {
    vi.mocked(requestDaemonUpdate).mockResolvedValue({
      ok: false,
      reason: "remote_error",
      message: "conductor was installed with Homebrew",
    });
    const res = await POST(createMockRequest({ method: "POST" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(502);
    expect(data.error).toMatch(/Homebrew/);
  });

  it("surfaces a daemon timeout as 504", async () => {
    vi.mocked(requestDaemonUpdate).mockResolvedValue({
      ok: false,
      reason: "timeout",
      message: "daemon did not respond within 15000ms",
    });
    const res = await GET(createMockRequest({ method: "GET" }), paramsFor("daemon-a"));

    expect(res.status).toBe(504);
  });
});
