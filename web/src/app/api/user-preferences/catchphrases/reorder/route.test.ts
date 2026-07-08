import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "./route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    userCatchphrase: {
      findMany: vi.fn(),
      update: vi.fn(),
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

const row = (id: string, sortOrder: number) => ({
  id,
  userId: "user-1",
  text: `phrase-${id}`,
  sortOrder,
  lastUsedAt: null,
  createdAt: new Date("2026-06-06T00:00:00Z"),
  updatedAt: new Date("2026-06-06T00:00:00Z"),
});

describe("PUT /api/user-preferences/catchphrases/reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.$transaction).mockImplementation(async (fn: any) => fn(db));
    vi.mocked(db.userCatchphrase.update).mockResolvedValue({} as any);
  });

  it("rewrites sort_order for an exact-match payload and broadcasts the snapshot", async () => {
    // First findMany: inside the transaction, returns the user's ids.
    // Second findMany (in listCatchphrases): returns the renumbered snapshot.
    vi.mocked(db.userCatchphrase.findMany)
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }] as any)
      .mockResolvedValueOnce([row("b", 0), row("a", 1)] as any);

    const response = await PUT(
      createMockRequest({
        method: "PUT",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/reorder",
        body: { ids: ["b", "a"] },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.catchphrases.map((row: any) => row.id)).toEqual(["b", "a"]);
    expect(db.userCatchphrase.update).toHaveBeenCalledTimes(2);
    expect(realtimeHub.broadcastToUser).toHaveBeenCalled();
  });

  it("rejects duplicate ids with 400 via the Zod schema", async () => {
    const response = await PUT(
      createMockRequest({
        method: "PUT",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/reorder",
        body: { ids: ["a", "a"] },
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toMatch(/duplicate/i);
    expect(db.userCatchphrase.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the payload does not match the user's current row set", async () => {
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValueOnce([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ] as any);

    const response = await PUT(
      createMockRequest({
        method: "PUT",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/reorder",
        // missing "c"
        body: { ids: ["a", "b"] },
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(409);
    expect(data.error).toMatch(/does not match/i);
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("returns 409 when the payload includes an id not owned by the user", async () => {
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValueOnce([
      { id: "a" },
      { id: "b" },
    ] as any);

    const response = await PUT(
      createMockRequest({
        method: "PUT",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/reorder",
        body: { ids: ["a", "evil"] },
      }),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(409);
    expect(data.error).toMatch(/not owned/i);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const response = await PUT(
      createMockRequest({
        method: "PUT",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/reorder",
        body: { ids: ["a"] },
      }),
    );
    expect(response.status).toBe(401);
  });
});
