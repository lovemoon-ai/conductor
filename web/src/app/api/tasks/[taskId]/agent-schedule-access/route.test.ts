import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/tasks/[taskId]/agent-schedule-access/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/db", () => ({
  db: { task: { findFirst: vi.fn(), update: vi.fn() } },
}));

const { db } = await import("@/lib/db");
const USER_ID = "user-1";
const TASK_ID = "task-1";

const params = { params: Promise.resolve({ taskId: TASK_ID }) };

describe("/api/tasks/[taskId]/agent-schedule-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: USER_ID,
      email: "t@e.com",
      phone: null,
    } as never);
  });

  it("GET returns the current access (default full)", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ metadata: null } as never);
    const res = await GET(
      createMockRequest({ method: "GET", token: createTestToken(USER_ID) }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await extractJson(res)).toEqual({ task_id: TASK_ID, access: "full" });
  });

  it("GET returns 404 for a task not owned by the caller", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null as never);
    const res = await GET(
      createMockRequest({ method: "GET", token: createTestToken(USER_ID) }),
      params,
    );
    expect(res.status).toBe(404);
  });

  it("PUT rejects an invalid access value", async () => {
    const res = await PUT(
      createMockRequest({ method: "PUT", token: createTestToken(USER_ID), body: { access: "nope" } }),
      params,
    );
    expect(res.status).toBe(400);
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("PUT stores a valid access value", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: TASK_ID, metadata: null } as never);
    vi.mocked(db.task.update).mockResolvedValue({} as never);
    const res = await PUT(
      createMockRequest({
        method: "PUT",
        token: createTestToken(USER_ID),
        body: { access: "read_only" },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await extractJson(res)).toEqual({ task_id: TASK_ID, access: "read_only" });
    const data = vi.mocked(db.task.update).mock.calls[0][0].data as { metadata: string };
    expect(JSON.parse(data.metadata)).toMatchObject({ agentScheduleAccess: "read_only" });
  });

  it("PUT returns 404 when the task is not owned by the caller", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null as never);
    const res = await PUT(
      createMockRequest({
        method: "PUT",
        token: createTestToken(USER_ID),
        body: { access: "blocked" },
      }),
      params,
    );
    expect(res.status).toBe(404);
  });
});
