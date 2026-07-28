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
  url: "http://localhost:6152/api/user-preferences/project-card-groups",
  body,
});

describe("/api/user-preferences/project-card-groups", () => {
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

  it("returns an empty versioned snapshot when nothing is stored", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await extractJson(response)).toEqual({ version: 1, revision: 0, scopes: {} });
  });

  it("rejects an unauthenticated request", async () => {
    vi.mocked(getAuthUser).mockResolvedValueOnce(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it("persists a valid aggregation scope and broadcasts the update", async () => {
    const body = {
      scope: "projects:all",
      groups: [{ id: "g1", projectIds: ["p1", "p2"], labels: { p1: "Frontend" } }],
    };
    const response = await PATCH(request("PATCH", body));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.revision).toBe(1);
    expect(data.scopes["projects:all"]).toEqual([
      { id: "g1", projectIds: ["p1", "p2"], labels: { p1: "Frontend" } },
    ]);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ type: "project_card_groups_update" }),
    );
  });

  it("rejects a scope outside the projects: namespace", async () => {
    const response = await PATCH(request("PATCH", {
      scope: "global",
      groups: [{ id: "g1", projectIds: ["p1", "p2"], labels: {} }],
    }));
    expect(response.status).toBe(400);
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("rejects a project id shared by two groups", async () => {
    const response = await PATCH(request("PATCH", {
      scope: "projects:all",
      groups: [
        { id: "g1", projectIds: ["p1", "p2"], labels: {} },
        { id: "g2", projectIds: ["p2", "p3"], labels: {} },
      ],
    }));
    expect(response.status).toBe(400);
  });

  it("rejects a group with fewer than two projects", async () => {
    const response = await PATCH(request("PATCH", {
      scope: "projects:all",
      groups: [{ id: "g1", projectIds: ["p1"], labels: {} }],
    }));
    expect(response.status).toBe(400);
  });
});
