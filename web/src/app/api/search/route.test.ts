import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/search/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/search/message-search", () => ({
  searchMessages: vi.fn(),
}));

const { searchMessages } = await import("@/lib/search/message-search");

const USER_ID = "user-1";

const callSearch = async (qs = "", authed = true) =>
  GET(
    createMockRequest({
      method: "GET",
      url: `http://localhost:6152/api/search${qs}`,
      token: authed ? createTestToken(USER_ID) : undefined,
    }),
  );

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: USER_ID,
      email: "test@example.com",
      phone: null,
    } as never);
    vi.mocked(searchMessages).mockResolvedValue({
      query: "api",
      backend: "fts",
      hits: [
        {
          taskId: "t-1",
          taskTitle: "Ship the API",
          messageId: "m-1",
          role: "assistant",
          snippet: "the [api] contract",
          createdAt: "2024-05-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("rejects unauthenticated callers", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);
    const res = await callSearch("?q=api", false);
    expect(res.status).toBe(401);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("returns an empty result without searching for a blank query", async () => {
    const res = await callSearch("?q=");
    expect(res.status).toBe(200);
    const body = await extractJson(res);
    expect(body.hits).toEqual([]);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("passes the query, limit and user scope through to searchMessages", async () => {
    const res = await callSearch("?q=api&limit=15");
    expect(res.status).toBe(200);
    const body = await extractJson(res);
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({ taskId: "t-1", messageId: "m-1" });
    expect(searchMessages).toHaveBeenCalledWith({
      userId: USER_ID,
      query: "api",
      limit: 15,
    });
  });
});
