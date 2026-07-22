import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "./route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: { broadcastToUser: vi.fn() },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { getAuthUser } = await import("@/lib/auth/middleware");

const request = (method = "GET", body?: unknown) => createMockRequest({
  method,
  token: createTestToken("user-1"),
  url: "http://localhost:6152/api/user-preferences/task-card-groups",
  body,
});

const missingUserPreferencesTableError = {
  code: "P2010",
  meta: { code: "42P01", message: 'relation "user_preferences" does not exist' },
  message: 'Raw query failed. relation "user_preferences" does not exist',
};

describe("/api/user-preferences/task-card-groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.$queryRaw).mockResolvedValue([]);
    vi.mocked(db.$executeRaw).mockResolvedValue(1);
  });

  it("returns an empty versioned snapshot when no groups are stored", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await extractJson(response)).toEqual({ version: 1, revision: 0, scopes: {} });
  });

  it("persists one scope and broadcasts the full normalized snapshot", async () => {
    const response = await PATCH(request("PATCH", {
      scope: "projects:project-1",
      groups: [{
        id: "group-1",
        taskIds: ["task-1", "task-2"],
        labels: { "task-1": "Design" },
      }],
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({
      version: 1,
      revision: 1,
      scopes: {
        "projects:project-1": [{
          id: "group-1",
          taskIds: ["task-1", "task-2"],
          labels: { "task-1": "Design" },
        }],
      },
    });
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith("user-1", {
      type: "task_card_groups_update",
      payload: {
        user_id: "user-1",
        snapshot: data,
        updated_at: expect.any(String),
      },
    });
  });

  it("retries a compare-and-swap collision and preserves another scope", async () => {
    const first = JSON.stringify({
      version: 1,
      revision: 3,
      scopes: { "projects:a": [] },
    });
    const concurrent = JSON.stringify({
      version: 1,
      revision: 4,
      scopes: { "projects:a": [], "projects:b": [] },
    });
    vi.mocked(db.$queryRaw)
      .mockResolvedValueOnce([{ value: first }])
      .mockResolvedValueOnce([{ value: concurrent }]);
    vi.mocked(db.$executeRaw).mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const response = await PATCH(request("PATCH", {
      scope: "projects:c",
      groups: [],
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.revision).toBe(5);
    expect(data.scopes).toEqual({
      "projects:a": [],
      "projects:b": [],
      "projects:c": [],
    });
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or cross-group duplicate task ids", async () => {
    const response = await PATCH(request("PATCH", {
      scope: "projects:project-1",
      groups: [
        { id: "one", taskIds: ["task-1", "task-2"], labels: {} },
        { id: "two", taskIds: ["task-2", "task-3"], labels: {} },
      ],
    }));

    expect(response.status).toBe(400);
    expect((await extractJson(response)).error).toContain("only one group");
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("keeps local grouping available when an old self-host schema cannot sync", async () => {
    vi.mocked(db.$queryRaw).mockRejectedValueOnce(missingUserPreferencesTableError);
    const response = await PATCH(request("PATCH", {
      scope: "projects:project-1",
      groups: [],
    }));

    expect(response.status).toBe(409);
    expect((await extractJson(response)).error).toContain("Task card group sync is unavailable");
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect((await extractJson(response)).error).toBe("Unauthorized");
  });
});
