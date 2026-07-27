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
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue({
      id: "dp-1",
      userId: "user-1",
      projectId: DEFAULT_PROJECT_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
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

  it("allows clearing the override even when the task's real project is no longer the default", async () => {
    // Simulates the user having switched their default project after moving a
    // task: the task's real projectId is now a non-default project, but it must
    // still be movable back to the inbox so it is not stranded.
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

  it("rejects moving a task whose real project is NOT the default project", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      projectId: "some-other-project",
    } as any);

    const response = await callPut({ second_project_id: TARGET_PROJECT_ID });
    expect(response.status).toBe(403);
    expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
  });

  it("rejects a target project that does not belong to the caller", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...baseTaskRow } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue(null);

    const response = await callPut({ second_project_id: "not-mine" });
    expect(response.status).toBe(404);
    expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
  });

  it("rejects using the default project itself as the target", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...baseTaskRow } as any);

    const response = await callPut({ second_project_id: DEFAULT_PROJECT_ID });
    expect(response.status).toBe(400);
    expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
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
