import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));
vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: { hasAgentHost: vi.fn() },
}));
vi.mock("@/lib/realtime/ai-manager", () => ({
  requestAiManager: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestAiManager } = await import("@/lib/realtime/ai-manager");
const { POST } = await import("./route");

describe("POST /api/ai-manager/switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "u@example.com",
      phone: null,
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
  });

  it("rejects invalid JSON body", async () => {
    const req = createMockRequest({ method: "POST", body: undefined });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("requires `name` in body", async () => {
    const req = createMockRequest({
      method: "POST",
      body: { agentHost: "m2" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await extractJson(res);
    expect(data.error).toMatch(/name/);
  });

  it("forwards successful switch result", async () => {
    vi.mocked(requestAiManager).mockResolvedValue({
      ok: true,
      action: "switch_account",
      result: { previousName: "a", newName: "b", backupPath: "/x.bak" },
    });
    const req = createMockRequest({
      method: "POST",
      body: { agentHost: "m2", name: "b" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await extractJson(res)).toMatchObject({ newName: "b" });
    expect(requestAiManager).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "switch_account",
        args: { name: "b" },
      }),
    );
  });

  it("returns 504 on timeout", async () => {
    vi.mocked(requestAiManager).mockResolvedValue({
      ok: false,
      reason: "timeout",
      message: "no response",
    });
    const req = createMockRequest({
      method: "POST",
      body: { agentHost: "m2", name: "b" },
    });
    const res = await POST(req);
    expect(res.status).toBe(504);
  });
});
