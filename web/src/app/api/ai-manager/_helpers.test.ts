import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    hasAgentHost: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/ai-manager", () => ({
  requestAiManager: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestAiManager } = await import("@/lib/realtime/ai-manager");
const { authorize, callAgent, outcomeToResponse } = await import("./_helpers");

describe("ai-manager route helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "u@example.com",
      phone: null,
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
  });

  it("authorize returns 400 when agentHost missing", async () => {
    const res = await authorize(createMockRequest({}), null);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("authorize returns 404 when agentHost not owned by user", async () => {
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    const res = await authorize(createMockRequest({}), "m9");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(404);
  });

  it("authorize rejects conductor-fire-* hosts with 400 (no realtime probe)", async () => {
    const res = await authorize(createMockRequest({}), "conductor-fire-debug-1");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
    // Must short-circuit before consulting the hub.
    expect(realtimeHub.hasAgentHost).not.toHaveBeenCalled();
    const data = await (res as Response).json();
    expect(data.error).toMatch(/conductor-fire/);
  });

  it("authorize returns context on success", async () => {
    const res = await authorize(createMockRequest({}), "m2");
    expect(res).toEqual({ userId: "user-1", agentHost: "m2" });
  });

  it("outcomeToResponse maps reasons to status codes", async () => {
    expect(outcomeToResponse({ ok: true, action: "status", result: { x: 1 } }).status).toBe(200);
    expect(
      outcomeToResponse({ ok: false, reason: "agent_offline", message: "x" }).status,
    ).toBe(404);
    expect(outcomeToResponse({ ok: false, reason: "timeout", message: "x" }).status).toBe(504);
    expect(
      outcomeToResponse({ ok: false, reason: "remote_error", message: "x" }).status,
    ).toBe(502);
  });

  it("callAgent forwards a successful result as JSON body", async () => {
    vi.mocked(requestAiManager).mockResolvedValue({
      ok: true,
      action: "status",
      result: { hello: "world" },
    });
    const ctx = { userId: "user-1", agentHost: "m2" };
    const res = await callAgent(ctx, "status");
    expect(res.status).toBe(200);
    expect(await extractJson(res)).toEqual({ hello: "world" });
    expect(requestAiManager).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        agentHost: "m2",
        action: "status",
      }),
    );
  });
});
