import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest } from "@/__tests__/helpers";

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
const { GET } = await import("./route");

describe("GET /api/ai-manager/quota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "u@example.com",
      phone: null,
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(requestAiManager).mockResolvedValue({
      ok: true,
      action: "quota",
      result: {},
    });
  });

  it("forwards external quota backend filters to the daemon", async () => {
    const req = createMockRequest({
      method: "GET",
      url: "http://localhost:6152/api/ai-manager/quota?agentHost=m2&tool=private-ext&externalQuotaBackend=private-ext&forceRefresh=1",
    });

    await GET(req);

    expect(requestAiManager).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        agentHost: "m2",
        action: "quota",
        args: {
          forceRefresh: true,
          tool: "private-ext",
          externalQuotaBackends: ["private-ext"],
        },
        timeoutMs: 30_000,
      }),
    );
  });
});
