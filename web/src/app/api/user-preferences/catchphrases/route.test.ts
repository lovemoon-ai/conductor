import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    userCatchphrase: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcastToUser: vi.fn(),
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { getAuthUser } = await import("@/lib/auth/middleware");

const sampleRow = (overrides: Partial<{
  id: string;
  text: string;
  sortOrder: number;
  lastUsedAt: Date | null;
}> = {}) => ({
  id: overrides.id ?? "cp-1",
  userId: "user-1",
  text: overrides.text ?? "请用中文回答",
  sortOrder: overrides.sortOrder ?? 0,
  lastUsedAt: overrides.lastUsedAt ?? null,
  createdAt: new Date("2026-06-06T00:00:00Z"),
  updatedAt: new Date("2026-06-06T00:00:00Z"),
});

describe("/api/user-preferences/catchphrases (collection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValue([]);
    vi.mocked(db.userCatchphrase.count).mockResolvedValue(0);
    vi.mocked(db.userCatchphrase.findFirst).mockResolvedValue(null);
    vi.mocked(db.userCatchphrase.create).mockImplementation(async ({ data }: any) =>
      sampleRow({ id: "cp-new", text: data.text, sortOrder: data.sortOrder }),
    );
    // Transparent passthrough for $transaction(async tx => ...).
    vi.mocked(db.$transaction).mockImplementation(async (fn: any) => fn(db));
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases",
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  it("returns the catchphrase list for the current user", async () => {
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValue([
      sampleRow({ id: "cp-1", text: "请用中文回答", sortOrder: 0 }),
      sampleRow({ id: "cp-2", text: "先给方案再写代码", sortOrder: 1 }),
    ]);
    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases",
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(data.catchphrases).toHaveLength(2);
    expect(data.catchphrases[0]).toMatchObject({
      id: "cp-1",
      text: "请用中文回答",
      sortOrder: 0,
    });
    // Scoped to userId only — cross-user isolation.
    expect(db.userCatchphrase.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: expect.any(Array),
    });
  });

  it("creates a new catchphrase, appends it at the tail, and broadcasts a snapshot", async () => {
    vi.mocked(db.userCatchphrase.findFirst).mockResolvedValue(
      sampleRow({ id: "cp-1", sortOrder: 4 }),
    );
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValue([
      sampleRow({ id: "cp-1", sortOrder: 4 }),
      sampleRow({ id: "cp-new", text: "hello", sortOrder: 5 }),
    ]);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases",
        body: { text: "  hello  " },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(201);
    expect(data.catchphrases).toHaveLength(2);
    expect(db.userCatchphrase.create).toHaveBeenCalledWith({
      data: { userId: "user-1", text: "hello", sortOrder: 5 },
    });
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith("user-1", {
      type: "user_catchphrase_update",
      payload: expect.objectContaining({
        catchphrases: expect.any(Array),
      }),
    });
  });

  it("rejects empty / whitespace-only text", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases",
        body: { text: "   " },
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toMatch(/empty/i);
    expect(db.userCatchphrase.create).not.toHaveBeenCalled();
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("rejects text longer than 500 characters", async () => {
    const tooLong = "x".repeat(501);
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases",
        body: { text: tooLong },
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toMatch(/at most 500/i);
  });

  it("returns 409 when the user already has 100 catchphrases", async () => {
    vi.mocked(db.userCatchphrase.count).mockResolvedValue(100);
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases",
        body: { text: "another" },
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(409);
    expect(data.error).toMatch(/at most 100/i);
    expect(db.userCatchphrase.create).not.toHaveBeenCalled();
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });
});
