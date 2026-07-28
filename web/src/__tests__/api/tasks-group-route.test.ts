import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tasks/[taskId]/group/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");

const token = createTestToken("user-1");

describe("GET /api/tasks/[taskId]/group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  it("404s when the task is not found / not owned", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null as any);
    const response = await GET(createMockRequest({ method: "GET", token }), {
      params: Promise.resolve({ taskId: "missing" }),
    });
    expect(response.status).toBe(404);
    expect(vi.mocked(db.task.findMany)).not.toHaveBeenCalled();
  });

  it("returns 409 when the group_id migration has not been applied", async () => {
    vi.mocked(db.task.findFirst).mockRejectedValue(
      Object.assign(
        new Error("The column `tasks.group_id` does not exist in the current database."),
        { code: "P2022" },
      ),
    );

    const response = await GET(createMockRequest({ method: "GET", token }), {
      params: Promise.resolve({ taskId: "worker-1" }),
    });
    const body = await extractJson(response);

    expect(response.status).toBe(409);
    expect(body.error).toContain("latest database migration");
    expect(vi.mocked(db.task.findMany)).not.toHaveBeenCalled();
  });

  it("reports no group for a standalone task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "W", groupId: null } as any);
    const response = await GET(createMockRequest({ method: "GET", token }), {
      params: Promise.resolve({ taskId: "W" }),
    });
    expect(response.status).toBe(200);
    expect(await extractJson(response)).toEqual({ group_id: null, members: [] });
    expect(vi.mocked(db.task.findMany)).not.toHaveBeenCalled();
  });

  it("returns all group members with role/agent and self marker", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "R", groupId: "grp-1" } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([
      {
        id: "W",
        title: "New Task",
        status: "running",
        backendType: "claude",
        metadata: JSON.stringify({ groupId: "grp-1", agentRole: "worker", agentName: "feature-dev" }),
        createdAt: new Date("2026-07-28T00:00:00Z"),
      },
      {
        id: "R",
        title: "Reviewer: code-reviewer",
        status: "running",
        backendType: "claude",
        metadata: JSON.stringify({ groupId: "grp-1", agentRole: "reviewer", agentName: "code-reviewer" }),
        createdAt: new Date("2026-07-28T00:00:01Z"),
      },
    ] as any);

    const response = await GET(createMockRequest({ method: "GET", token }), {
      params: Promise.resolve({ taskId: "R" }),
    });
    expect(response.status).toBe(200);
    const body = await extractJson(response);
    expect(body.group_id).toBe("grp-1");
    expect(body.members).toEqual([
      {
        task_id: "W",
        role: "worker",
        agent: "feature-dev",
        title: "New Task",
        status: "running",
        backend_type: "claude",
        is_self: false,
      },
      {
        task_id: "R",
        role: "reviewer",
        agent: "code-reviewer",
        title: "Reviewer: code-reviewer",
        status: "running",
        backend_type: "claude",
        is_self: true,
      },
    ]);

    // scoped to the resolved group id + owner
    const findManyArg = vi.mocked(db.task.findMany).mock.calls[0][0];
    expect(findManyArg).toMatchObject({
      where: { groupId: "grp-1", project: { userId: "user-1" } },
    });
  });

  it("tolerates members with unparseable metadata (null role/agent)", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "W", groupId: "grp-2" } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([
      {
        id: "W",
        title: "New Task",
        status: "running",
        backendType: null,
        metadata: "not json",
        createdAt: new Date("2026-07-28T00:00:00Z"),
      },
    ] as any);

    const response = await GET(createMockRequest({ method: "GET", token }), {
      params: Promise.resolve({ taskId: "W" }),
    });
    const body = await extractJson(response);
    expect(body.members[0]).toMatchObject({ task_id: "W", role: null, agent: null, is_self: true });
  });
});
