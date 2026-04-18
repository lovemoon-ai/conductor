import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/agents/[host]/restart/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");

const authedUser = {
  id: "user-1",
  email: "test@example.com",
  phone: null,
} as any;

const paramsFor = (host: string) => ({ params: Promise.resolve({ host }) });

const agentWithRestart = (host: string) => ({
  id: `agent-${host}`,
  host,
  supportedBackends: ["codex"],
  capabilities: ["project_path_validation", "restart_daemon"],
});

describe("POST /api/agents/[host]/restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue(authedUser);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([agentWithRestart("daemon-a")]);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
  });

  it("returns 401 passthrough when unauthenticated", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }) as any,
    );
    const req = createMockRequest({ method: "POST", body: {} });
    const res = await POST(req, paramsFor("daemon-a"));
    expect(res.status).toBe(401);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("returns 404 when daemon is not connected for this user", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    const req = createMockRequest({ method: "POST", body: { targetVersion: "latest" } });
    const res = await POST(req, paramsFor("daemon-a"));

    expect(res.status).toBe(404);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("returns 409 when daemon lacks restart_daemon capability", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-old",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["project_path_validation"],
      },
    ]);
    const req = createMockRequest({ method: "POST", body: {} });
    const res = await POST(req, paramsFor("daemon-a"));

    expect(res.status).toBe(409);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("rejects invalid targetVersion with 400", async () => {
    const req = createMockRequest({ method: "POST", body: { targetVersion: "not-semver" } });
    const res = await POST(req, paramsFor("daemon-a"));

    expect(res.status).toBe(400);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("returns 502 when hub cannot deliver", async () => {
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(false);
    const req = createMockRequest({ method: "POST", body: {} });
    const res = await POST(req, paramsFor("daemon-a"));

    expect(res.status).toBe(502);
  });

  it("dispatches restart_daemon with latest by default", async () => {
    const req = createMockRequest({ method: "POST", body: {} });
    const res = await POST(req, paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledTimes(1);
    const [userIdArg, hostArg, payloadArg] = vi.mocked(realtimeHub.sendToAgentHost).mock.calls[0];
    expect(userIdArg).toBe("user-1");
    expect(hostArg).toBe("daemon-a");
    expect(payloadArg).toMatchObject({
      type: "restart_daemon",
      payload: expect.objectContaining({
        target_version: "latest",
        request_id: expect.stringMatching(/^restart-/),
      }),
    });
  });

  it("forwards an explicit semver targetVersion", async () => {
    const req = createMockRequest({ method: "POST", body: { targetVersion: "0.2.36" } });
    const res = await POST(req, paramsFor("daemon-a"));
    expect(res.status).toBe(200);
    const [, , payloadArg] = vi.mocked(realtimeHub.sendToAgentHost).mock.calls[0];
    expect((payloadArg as any).payload.target_version).toBe("0.2.36");
  });

  it("URL-decodes the host path param", async () => {
    const encoded = encodeURIComponent("daemon host@1");
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([agentWithRestart("daemon host@1")]);
    const req = createMockRequest({ method: "POST", body: {} });
    const res = await POST(req, paramsFor(encoded));
    expect(res.status).toBe(200);
    const [, hostArg] = vi.mocked(realtimeHub.sendToAgentHost).mock.calls[0];
    expect(hostArg).toBe("daemon host@1");
  });
});
