import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/agents/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
  },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");

describe("/api/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  it("returns connected agents with version metadata when present", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-a",
        supportedBackends: ["codex"],
        runtimeBackendMap: { codex: "codex" },
        capabilities: ["pty_task"],
        version: "0.2.21",
      },
      {
        id: "agent-2",
        host: "daemon-b",
        supportedBackends: ["claude"],
        capabilities: [],
        version: undefined,
      },
    ]);

    const response = await GET(createMockRequest({}));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual([
      {
        id: "agent-1",
        host: "daemon-a",
        supportedBackends: ["codex"],
        runtimeBackendMap: { codex: "codex" },
        capabilities: ["pty_task"],
        version: "0.2.21",
      },
      {
        id: "agent-2",
        host: "daemon-b",
        supportedBackends: ["claude"],
        capabilities: [],
      },
    ]);
  });
});
