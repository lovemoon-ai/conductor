import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH, DELETE } from "./route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    userCatchphrase: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
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

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const row = (overrides: Partial<{ id: string; text: string; sortOrder: number }> = {}) => ({
  id: overrides.id ?? "cp-1",
  userId: "user-1",
  text: overrides.text ?? "hello",
  sortOrder: overrides.sortOrder ?? 0,
  lastUsedAt: null,
  createdAt: new Date("2026-06-06T00:00:00Z"),
  updatedAt: new Date("2026-06-06T00:00:00Z"),
});

describe("/api/user-preferences/catchphrases/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValue([row()]);
    vi.mocked(db.userCatchphrase.findFirst).mockResolvedValue(row());
    vi.mocked(db.userCatchphrase.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(db.userCatchphrase.deleteMany).mockResolvedValue({ count: 1 });
  });

  it("PATCH updates a row scoped to userId and broadcasts the snapshot", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-1",
        body: { text: "new text" },
      }),
      params("cp-1"),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(data.catchphrases).toHaveLength(1);
    expect(db.userCatchphrase.updateMany).toHaveBeenCalledWith({
      where: { id: "cp-1", userId: "user-1" },
      data: { text: "new text" },
    });
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "user_catchphrase_update",
    }));
  });

  it("PATCH returns 404 when the row belongs to another user (updateMany count=0)", async () => {
    vi.mocked(db.userCatchphrase.updateMany).mockResolvedValue({ count: 0 });
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-other",
        body: { text: "evil" },
      }),
      params("cp-other"),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(404);
    expect(data.error).toMatch(/not found/i);
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("PATCH rejects empty text", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-1",
        body: { text: "" },
      }),
      params("cp-1"),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toMatch(/empty/i);
    expect(db.userCatchphrase.updateMany).not.toHaveBeenCalled();
  });

  it("DELETE removes a row scoped to userId and broadcasts", async () => {
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValue([]);
    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-1",
      }),
      params("cp-1"),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(data.catchphrases).toEqual([]);
    expect(db.userCatchphrase.deleteMany).toHaveBeenCalledWith({
      where: { id: "cp-1", userId: "user-1" },
    });
    expect(realtimeHub.broadcastToUser).toHaveBeenCalled();
  });

  it("DELETE returns 404 when the row belongs to another user", async () => {
    vi.mocked(db.userCatchphrase.deleteMany).mockResolvedValue({ count: 0 });
    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-other",
      }),
      params("cp-other"),
    );
    expect(response.status).toBe(404);
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-1",
        body: { text: "hi" },
      }),
      params("cp-1"),
    );
    expect(response.status).toBe(401);
  });
});
