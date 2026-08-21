import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/service", () => ({ authenticateToken: vi.fn() }));
const { authenticateToken } = await import("@/lib/auth/service");
const { authenticateAgentRequest } = await import("./agent-request");

describe("authenticateAgentRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds authentication to the asserted host", async () => {
    vi.mocked(authenticateToken).mockResolvedValue({ id: "user-1" } as any);
    const request = new NextRequest("http://localhost/api/agent", { headers: {
      Authorization: "Bearer agent-token", "X-Conductor-Host": "daemon-a",
    } });
    await expect(authenticateAgentRequest(request)).resolves.toMatchObject({ agentHost: "daemon-a" });
    expect(authenticateToken).toHaveBeenCalledWith("agent-token");
  });

  it("rejects requests without a host before granting access", async () => {
    const request = new NextRequest("http://localhost/api/agent", { headers: { Authorization: "Bearer token" } });
    await expect(authenticateAgentRequest(request)).resolves.toBeNull();
  });
});
