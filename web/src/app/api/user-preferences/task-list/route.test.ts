import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "./route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
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

const missingUserPreferencesTableError = () => ({
  code: "P2010",
  meta: {
    code: "42P01",
    message: 'relation "user_preferences" does not exist',
  },
  message: 'Raw query failed. relation "user_preferences" does not exist',
});

describe("/api/user-preferences/task-list", () => {
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

  it("returns default task list preferences when none are stored", async () => {
    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/task-list",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({
      tasksRunningOnly: false,
      tasks_running_only: false,
    });
  });

  it("returns stored task list preferences", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([
      { value: JSON.stringify({ tasksRunningOnly: true }) },
    ]);

    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/task-list",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.tasksRunningOnly).toBe(true);
    expect(data.tasks_running_only).toBe(true);
  });

  it("falls back to defaults when the preferences table is missing on read", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(db.$queryRaw).mockRejectedValueOnce(missingUserPreferencesTableError());

    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/task-list",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({
      tasksRunningOnly: false,
      tasks_running_only: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("user_preferences table is missing"));
    warnSpy.mockRestore();
  });

  it("persists task list preferences and broadcasts the update", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/task-list",
        body: { tasksRunningOnly: true },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.tasksRunningOnly).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith("user-1", {
      type: "user_preference_update",
      payload: expect.objectContaining({
        scope: "task_list",
        preferences: {
          tasksRunningOnly: true,
          tasks_running_only: true,
        },
      }),
    });
  });

  it("returns 409 and skips broadcast when the preferences table is missing on write", async () => {
    vi.mocked(db.$executeRaw).mockRejectedValueOnce(missingUserPreferencesTableError());

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/task-list",
        body: { tasksRunningOnly: true },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("Task list preferences are unavailable");
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("rejects invalid task list preference payloads", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/user-preferences/task-list",
        body: { tasksRunningOnly: "yes" },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("tasksRunningOnly must be a boolean");
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(realtimeHub.broadcastToUser).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);

    const response = await GET(createMockRequest({
      token: createTestToken("user-1"),
      url: "http://localhost:6152/api/user-preferences/task-list",
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });
});
