import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "./route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    daemonShare: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcastToUser: vi.fn(),
    getAgentsForUser: vi.fn(),
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { getAuthUser } = await import("@/lib/auth/middleware");

const URL = "http://localhost:6152/api/user-preferences/global-ai-backends";
const put = (body: unknown) =>
  PUT(createMockRequest({ method: "PUT", token: createTestToken("user-1"), url: URL, body }));
const storedValue = (backends: unknown[]) => [{ value: JSON.stringify({ backends }) }];

describe("/api/user-preferences/global-ai-backends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({ id: "user-1", email: "test@example.com", phone: null });
    vi.mocked(db.$queryRaw).mockResolvedValue([]);
    vi.mocked(db.$executeRaw).mockResolvedValue(1);
    vi.mocked(db.daemonShare.findMany).mockResolvedValue([]);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { host: "macmini", supportedBackends: ["claude", "codex"] },
      { host: "ubuntu", supportedBackends: ["codex"] },
    ] as any);
  });

  it("returns an empty list by default and the stored list otherwise", async () => {
    let response = await GET(createMockRequest({ token: createTestToken("user-1"), url: URL }));
    expect(await extractJson(response)).toEqual({ backends: [] });

    vi.mocked(db.$queryRaw).mockResolvedValue(storedValue([{ host: "macmini", backend: "claude" }]));
    response = await GET(createMockRequest({ token: createTestToken("user-1"), url: URL }));
    expect(await extractJson(response)).toEqual({ backends: [{ host: "macmini", backend: "claude" }] });
  });

  it("saves backends advertised by the user's online daemons, deduplicated, and broadcasts them", async () => {
    const response = await put({
      backends: [
        { host: "macmini", backend: "claude" },
        { host: "macmini", backend: "Claude" },
        { host: "ubuntu", backend: "codex" },
      ],
    });
    expect(response.status).toBe(200);
    const expected = [
      { host: "macmini", backend: "claude" },
      { host: "ubuntu", backend: "codex" },
    ];
    expect(await extractJson(response)).toEqual({ backends: expected });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "user_preference_update",
      payload: expect.objectContaining({ scope: "global_ai_backends", preferences: { backends: expected } }),
    }));
  });

  it("keeps an already saved backend while its daemon is offline, but rejects adding a new one", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(storedValue([{ host: "studio", backend: "claude" }]));
    let response = await put({ backends: [{ host: "studio", backend: "claude" }] });
    expect(response.status).toBe(200);

    response = await put({ backends: [{ host: "studio", backend: "codex" }] });
    expect(response.status).toBe(400);
    expect((await extractJson(response)).error).toBe("codex @ studio: daemon studio is offline");
  });

  it("rejects unsupported backends, fire hosts, shared daemons and malformed entries", async () => {
    let response = await put({ backends: [{ host: "ubuntu", backend: "claude" }] });
    expect(response.status).toBe(400);
    expect((await extractJson(response)).error).toMatch(/does not support claude/);

    response = await put({ backends: [{ host: "conductor-fire-macmini-1", backend: "claude" }] });
    expect(response.status).toBe(400);

    vi.mocked(db.daemonShare.findMany).mockResolvedValue([{ guestHost: "ubuntu" }] as any);
    response = await put({ backends: [{ host: "ubuntu", backend: "codex" }] });
    expect(response.status).toBe(400);
    expect((await extractJson(response)).error).toMatch(/shared with you/);

    response = await put({ backends: [{ host: "macmini" }] });
    expect(response.status).toBe(400);
    response = await put({ backends: "macmini" });
    expect(response.status).toBe(400);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("is unavailable to a shared daemon token", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1", email: null, phone: null, tokenScope: "daemon_share",
    } as any);
    const response = await put({ backends: [{ host: "macmini", backend: "claude" }] });
    expect(response.status).toBe(403);
    const list = await GET(createMockRequest({ token: createTestToken("user-1"), url: URL }));
    expect(await extractJson(list)).toEqual({ backends: [] });
  });
});
