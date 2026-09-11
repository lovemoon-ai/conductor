import { mockPrismaQuery } from '@/__tests__/mock-prisma-query';
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PUT } from "@/app/api/tasks/[taskId]/second-project/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return {
    ...mod,
    checkAndUpdateExpiredSubscription: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    defaultProject: {
      findUnique: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");

const DEFAULT_PROJECT_ID = "default-project-1";
const TARGET_PROJECT_ID = "target-project-1";

const baseTaskRow = {
  id: "task-1",
  projectId: DEFAULT_PROJECT_ID,
  secondProjectId: null as string | null,
  issueId: null,
  title: "Grown-up task",
  taskType: "ai_task",
  status: "running",
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  backendType: "codex",
  sessionId: "sess-1",
  sessionFilePath: null,
  launchConfig: null,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  ptySession: null,
};

const callPut = async (body: unknown, taskId = "task-1") => {
  const token = createTestToken("user-1");
  const request = createMockRequest({
    method: "PUT",
    url: `http://localhost:6152/api/tasks/${taskId}/second-project`,
    token,
    body,
  });
  return PUT(request, { params: Promise.resolve({ taskId }) });
};

describe("PUT /api/tasks/[taskId]/second-project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
      subscriptionStatus: "ACTIVE",
      subscriptionTier: "PLUS",
      subscriptionEndsAt: new Date(Date.now() + 86400000),
      trialEndsAt: null,
      lastPaymentAt: null,
    } as any);
    mockPrismaQuery(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...baseTaskRow,
      secondProjectId: data.secondProjectId,
    }) as any);
  });

  it("moves a default-project task to a target project (sets secondProjectId)", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...baseTaskRow } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: TARGET_PROJECT_ID,
      userId: "user-1",
    } as any);

    const response = await callPut({ second_project_id: TARGET_PROJECT_ID });
    expect(response.status).toBe(200);
    const json = await extractJson(response);
    expect(json.second_project_id).toBe(TARGET_PROJECT_ID);
    // Real project association is untouched.
    expect(json.project_id).toBe(DEFAULT_PROJECT_ID);
    expect(vi.mocked(db.task.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: { secondProjectId: TARGET_PROJECT_ID },
      }),
    );
  });

  it("moves a task back to default when second_project_id is null", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      secondProjectId: TARGET_PROJECT_ID,
    } as any);

    const response = await callPut({ second_project_id: null });
    expect(response.status).toBe(200);
    const json = await extractJson(response);
    expect(json.second_project_id).toBeNull();
    expect(vi.mocked(db.project.findFirst)).not.toHaveBeenCalled();
    expect(vi.mocked(db.task.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { secondProjectId: null } }),
    );
  });

  it("allows clearing the override for a task whose real project is not the default", async () => {
    // Clearing always files the task back under its own real project, whatever
    // that is, so a moved task can never be stranded.
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      projectId: "former-default-project",
      secondProjectId: TARGET_PROJECT_ID,
    } as any);

    const response = await callPut({ second_project_id: null });
    expect(response.status).toBe(200);
    const json = await extractJson(response);
    expect(json.second_project_id).toBeNull();
    expect(vi.mocked(db.task.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { secondProjectId: null } }),
    );
  });

  it("moves a task whose real project is NOT the default project", async () => {
    // Any owned task can be filed under any other own project, not just tasks
    // that live in the default project.
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      projectId: "some-other-project",
    } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: TARGET_PROJECT_ID,
      userId: "user-1",
    } as any);

    const response = await callPut({ second_project_id: TARGET_PROJECT_ID });
    expect(response.status).toBe(200);
    expect(vi.mocked(db.task.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { secondProjectId: TARGET_PROJECT_ID } }),
    );
  });

  it("allows the default project itself as a target for a non-default task", async () => {
    // Filing an "archive"-style task back into the inbox is a real move now
    // that the source no longer has to be the default project.
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      projectId: "some-other-project",
    } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: DEFAULT_PROJECT_ID,
      userId: "user-1",
    } as any);

    const response = await callPut({ second_project_id: DEFAULT_PROJECT_ID });
    expect(response.status).toBe(200);
    const json = await extractJson(response);
    expect(json.second_project_id).toBe(DEFAULT_PROJECT_ID);
  });

  it("rejects a target project that does not belong to the caller", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...baseTaskRow } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue(null);

    const response = await callPut({ second_project_id: "not-mine" });
    expect(response.status).toBe(404);
    expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
  });

  it("normalises a target equal to the task's own project to null", async () => {
    // Filing a task under the project it already belongs to is the same as
    // having no override, so it is stored as null rather than a self-reference
    // that would go stale if the task were ever reparented.
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      secondProjectId: TARGET_PROJECT_ID,
    } as any);

    const response = await callPut({ second_project_id: DEFAULT_PROJECT_ID });
    expect(response.status).toBe(200);
    const json = await extractJson(response);
    expect(json.second_project_id).toBeNull();
    expect(vi.mocked(db.project.findFirst)).not.toHaveBeenCalled();
    expect(vi.mocked(db.task.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { secondProjectId: null } }),
    );
  });

  it("does not depend on the user's default-project mapping", async () => {
    // Eligibility used to hinge on the default project; it must not anymore,
    // including for users whose default mapping row is missing.
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue(null);
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...baseTaskRow } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: TARGET_PROJECT_ID,
      userId: "user-1",
    } as any);

    const response = await callPut({ second_project_id: TARGET_PROJECT_ID });
    expect(response.status).toBe(200);
    expect(vi.mocked(db.defaultProject.findUnique)).not.toHaveBeenCalled();
  });

  it("returns 404 for a task the caller does not own", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null);

    const response = await callPut({ second_project_id: TARGET_PROJECT_ID });
    expect(response.status).toBe(404);
  });

  it("requires the second_project_id field to be present", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...baseTaskRow } as any);

    const response = await callPut({});
    expect(response.status).toBe(400);
  });
});
