import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
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
    },
  },
}));

const { db } = await import("@/lib/db");
const { getAuthUser } = await import("@/lib/auth/middleware");

const row = (overrides: Partial<{ id: string; lastUsedAt: Date | null }> = {}) => ({
  id: overrides.id ?? "cp-1",
  userId: "user-1",
  text: "hello",
  sortOrder: 0,
  lastUsedAt: overrides.lastUsedAt ?? new Date("2026-06-07T00:00:00Z"),
  createdAt: new Date("2026-06-06T00:00:00Z"),
  updatedAt: new Date("2026-06-07T00:00:00Z"),
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/user-preferences/catchphrases/[id]/touch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.userCatchphrase.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(db.userCatchphrase.findFirst).mockResolvedValue(row());
    vi.mocked(db.userCatchphrase.findMany).mockResolvedValue([row()]);
  });

  it("bumps lastUsedAt for a row that belongs to the caller", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-1/touch",
      }),
      params("cp-1"),
    );
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(data.catchphrases).toHaveLength(1);
    expect(db.userCatchphrase.updateMany).toHaveBeenCalledWith({
      where: { id: "cp-1", userId: "user-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("returns 404 when the row belongs to another user", async () => {
    vi.mocked(db.userCatchphrase.updateMany).mockResolvedValue({ count: 0 });
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-other/touch",
      }),
      params("cp-other"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/catchphrases/cp-1/touch",
      }),
      params("cp-1"),
    );
    expect(response.status).toBe(401);
    expect(db.userCatchphrase.updateMany).not.toHaveBeenCalled();
  });
});
