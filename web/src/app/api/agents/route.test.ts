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

// RFC 0035: the route annotates borrowed daemons, so it now reads the share
// table. Default to "no shares" so existing expectations describe the ordinary
// single-tenant case.
vi.mock("@/lib/db", () => ({
  db: { daemonShare: { findMany: vi.fn() } },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { db } = await import("@/lib/db");

describe("/api/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(db.daemonShare.findMany).mockResolvedValue([] as any);
  });

  it("marks a borrowed daemon as shared and names its owner", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "my-laptop", supportedBackends: [], capabilities: [] },
      { id: "agent-2", host: "shared-alice-alice-mbp", supportedBackends: [], capabilities: [] },
    ] as any);
    vi.mocked(db.daemonShare.findMany).mockResolvedValue([
      {
        guestHost: "shared-alice-alice-mbp",
        owner: { id: "user-a", email: "alice@example.com", phone: null },
      },
    ] as any);

    const response = await GET(createMockRequest({ url: "http://localhost/api/agents" }) as any);
    const body = await extractJson(response);

    expect(body[0]).toMatchObject({ host: "my-laptop", shared: false, ownerLabel: null });
    // Label only -- never the raw email, since this is the same identity data
    // the invite endpoint deliberately withholds.
    expect(body[1]).toMatchObject({
      host: "shared-alice-alice-mbp",
      shared: true,
      ownerLabel: "alice",
    });
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
        shared: false,
        ownerLabel: null,
      },
      {
        id: "agent-2",
        host: "daemon-b",
        supportedBackends: ["claude"],
        capabilities: [],
        shared: false,
        ownerLabel: null,
      },
    ]);
  });
});
