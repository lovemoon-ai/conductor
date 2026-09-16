import { mockPrismaQuery } from '@/__tests__/mock-prisma-query';
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PUT } from "@/app/api/tasks/[taskId]/labels/route";
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
    project: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");

const PROJECT_ID = "project-1";

/** Labels as they are stored: a JSON string in `project.metadata`. */
const metadataWithLabels = (
  labels: Array<{ id: string; name: string }>,
) => JSON.stringify({ taskLabels: labels });

const baseProjectRow = {
  id: PROJECT_ID,
  userId: "user-1",
  name: "conductor",
  daemonHost: "mac-mini",
  gitRemoteUrl: "github.com/acme/conductor",
  mergeOptOut: false,
  metadata: metadataWithLabels([
    { id: "l1", name: "bug" },
    { id: "l2", name: "chore" },
  ]),
};

const baseTaskRow = {
  id: "task-1",
  projectId: PROJECT_ID,
  secondProjectId: null as string | null,
  issueId: null,
  title: "Labelled task",
  taskType: "ai_task",
  status: "running",
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  backendType: "codex",
  sessionId: "sess-1",
  sessionFilePath: null,
  launchConfig: null,
  metadata: null as string | null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  ptySession: null,
  project: baseProjectRow,
};

const callPut = async (body: unknown, taskId = "task-1") => {
  const token = createTestToken("user-1");
  const request = createMockRequest({
    method: "PUT",
    url: `http://localhost:6152/api/tasks/${taskId}/labels`,
    token,
    body,
  });
  return PUT(request, { params: Promise.resolve({ taskId }) });
};

/** The metadata object the route persisted, parsed back out of the mock call. */
const writtenMetadata = (): Record<string, unknown> => {
  const call = vi.mocked(db.task.update).mock.calls[0]?.[0] as any;
  return JSON.parse(call.data.metadata);
};

describe("PUT /api/tasks/[taskId]/labels", () => {
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
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...baseTaskRow } as any);
    // No merged siblings unless a test says otherwise.
    mockPrismaQuery(db.project.findMany).mockResolvedValue([] as any);
    mockPrismaQuery(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...baseTaskRow,
      metadata: data.metadata,
    }) as any);
  });

  it("attaches labels defined on the task's own project", async () => {
    const response = await callPut({ label_ids: ["l1", "l2"] });
    expect(response.status).toBe(200);
    const json = await extractJson(response);
    expect(json.metadata.labelIds).toEqual(["l1", "l2"]);
  });

  it("accepts the camelCase field name too", async () => {
    const response = await callPut({ labelIds: ["l1"] });
    expect(response.status).toBe(200);
    expect(writtenMetadata().labelIds).toEqual(["l1"]);
  });

  it("clears every label when given an empty list", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      metadata: JSON.stringify({ labelIds: ["l1"], daemonName: "mac-mini" }),
    } as any);

    const response = await callPut({ label_ids: [] });
    expect(response.status).toBe(200);
    const persisted = writtenMetadata();
    expect("labelIds" in persisted).toBe(false);
    // Unrelated daemon-owned keys survive the clear.
    expect(persisted.daemonName).toBe("mac-mini");
    // No point resolving the project's labels when the list is empty.
    expect(vi.mocked(db.project.findMany)).not.toHaveBeenCalled();
  });

  it("preserves daemon-owned metadata when attaching labels", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      metadata: JSON.stringify({ daemonName: "mac-mini", backendType: "claude" }),
    } as any);

    const response = await callPut({ label_ids: ["l1"] });
    expect(response.status).toBe(200);
    expect(writtenMetadata()).toEqual({
      daemonName: "mac-mini",
      backendType: "claude",
      labelIds: ["l1"],
    });
  });

  it("dedupes ids and preserves order", async () => {
    const response = await callPut({ label_ids: ["l2", "l1", "l2"] });
    expect(response.status).toBe(200);
    expect(writtenMetadata().labelIds).toEqual(["l2", "l1"]);
  });

  it("accepts a label defined only on a merged cross-daemon sibling", async () => {
    // The settings dialog presents the whole merged group's labels as one list,
    // so an id owned by a sibling row is legitimate on this task.
    mockPrismaQuery(db.project.findMany).mockResolvedValue([
      {
        id: "project-2",
        userId: "user-1",
        name: "conductor",
        daemonHost: "linux-box",
        gitRemoteUrl: "github.com/acme/conductor",
        mergeOptOut: false,
        metadata: metadataWithLabels([{ id: "sibling-label", name: "infra" }]),
      },
    ] as any);

    const response = await callPut({ label_ids: ["sibling-label"] });
    expect(response.status).toBe(200);
    expect(writtenMetadata().labelIds).toEqual(["sibling-label"]);
  });

  it("rejects a label owned by a same-named project that does NOT merge", async () => {
    // Same name, but a different git remote — `canMergeProjectsByFields` vetoes
    // the pairing, so its labels must not leak into this project.
    mockPrismaQuery(db.project.findMany).mockResolvedValue([
      {
        id: "project-3",
        userId: "user-1",
        name: "conductor",
        daemonHost: "linux-box",
        gitRemoteUrl: "github.com/other/conductor",
        mergeOptOut: false,
        metadata: metadataWithLabels([{ id: "foreign", name: "nope" }]),
      },
    ] as any);

    const response = await callPut({ label_ids: ["foreign"] });
    expect(response.status).toBe(400);
    const json = await extractJson(response);
    expect(json.error).toContain("foreign");
    expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
  });

  it("rejects an unknown label id rather than silently dropping it", async () => {
    const response = await callPut({ label_ids: ["l1", "made-up"] });
    expect(response.status).toBe(400);
    const json = await extractJson(response);
    expect(json.error).toContain("made-up");
    expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
  });

  describe("task filed under another project (secondProjectId)", () => {
    // Regression: the task card offers the labels of the project a task is
    // DISPLAYED under, but the route only validated the real project. Labelling
    // any filed task (e.g. a default-project task moved into a project) 400'd.
    const filedTask = (metadata: string | null = null) => ({
      ...baseTaskRow,
      projectId: "default-project",
      secondProjectId: "display-project",
      metadata,
      project: {
        id: "default-project",
        userId: "user-1",
        name: "Default",
        daemonHost: null,
        mergeOptOut: false,
        metadata: null,
      },
    });
    const displayProject = {
      id: "display-project",
      userId: "user-1",
      name: "conductor",
      daemonHost: "mac-mini",
      gitRemoteUrl: "github.com/acme/conductor",
      mergeOptOut: false,
      metadata: metadataWithLabels([{ id: "display-label", name: "infra" }]),
    };

    it("accepts a label defined on the display project", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(filedTask() as any);
      vi.mocked(db.project.findFirst).mockResolvedValue(displayProject as any);

      const response = await callPut({ label_ids: ["display-label"] });

      expect(response.status).toBe(200);
      expect(writtenMetadata().labelIds).toEqual(["display-label"]);
      // The override is resolved within the caller's own projects only.
      expect(vi.mocked(db.project.findFirst)).toHaveBeenCalledWith({
        where: { id: "display-project", userId: "user-1" },
      });
    });

    it("accepts a label from the display project's merged sibling", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(filedTask() as any);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        ...displayProject,
        metadata: null,
      } as any);
      mockPrismaQuery(db.project.findMany).mockResolvedValue([
        {
          id: "display-sibling",
          userId: "user-1",
          name: "conductor",
          daemonHost: "linux-box",
          gitRemoteUrl: "github.com/acme/conductor",
          mergeOptOut: false,
          metadata: metadataWithLabels([{ id: "sibling-label", name: "ops" }]),
        },
      ] as any);

      const response = await callPut({ label_ids: ["sibling-label"] });

      expect(response.status).toBe(200);
    });

    it("rejects a label when the override points at a project the caller does not own", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(filedTask() as any);
      vi.mocked(db.project.findFirst).mockResolvedValue(null as any);

      const response = await callPut({ label_ids: ["display-label"] });

      expect(response.status).toBe(400);
      expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
    });
  });

  describe("ids the task already carries", () => {
    it("keeps an id that is no longer defined while adding a valid one", async () => {
      // Regression companion: pickers preserve ids they don't define (a deleted
      // label, or one from the task's other project). Validating those would
      // make every later edit on the task fail.
      vi.mocked(db.task.findFirst).mockResolvedValue({
        ...baseTaskRow,
        metadata: JSON.stringify({ labelIds: ["deleted-label"] }),
      } as any);

      const response = await callPut({ label_ids: ["l1", "deleted-label"] });

      expect(response.status).toBe(200);
      expect(writtenMetadata().labelIds).toEqual(["l1", "deleted-label"]);
    });

    it("skips the definition lookup entirely when nothing new is added", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue({
        ...baseTaskRow,
        metadata: JSON.stringify({ labelIds: ["deleted-label", "l1"] }),
      } as any);

      const response = await callPut({ label_ids: ["deleted-label"] });

      expect(response.status).toBe(200);
      expect(vi.mocked(db.project.findMany)).not.toHaveBeenCalled();
      expect(vi.mocked(db.project.findFirst)).not.toHaveBeenCalled();
    });

    it("still rejects a NEW id that is not defined anywhere", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue({
        ...baseTaskRow,
        metadata: JSON.stringify({ labelIds: ["deleted-label"] }),
      } as any);

      const response = await callPut({ label_ids: ["deleted-label", "made-up"] });

      expect(response.status).toBe(400);
      const json = await extractJson(response);
      expect(json.error).toContain("made-up");
      expect(json.error).not.toContain("deleted-label");
    });
  });

  it("requires the label_ids field", async () => {
    const response = await callPut({});
    expect(response.status).toBe(400);
    const json = await extractJson(response);
    expect(json.error).toContain("label_ids is required");
  });

  it("rejects a non-array label_ids", async () => {
    const response = await callPut({ label_ids: "l1" });
    expect(response.status).toBe(400);
    const json = await extractJson(response);
    expect(json.error).toContain("must be an array");
  });

  it("rejects non-string entries", async () => {
    const response = await callPut({ label_ids: ["l1", 7] });
    expect(response.status).toBe(400);
    const json = await extractJson(response);
    expect(json.error).toContain("only strings");
  });

  it("404s for a task the caller does not own", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null as any);
    const response = await callPut({ label_ids: ["l1"] });
    expect(response.status).toBe(404);
    expect(vi.mocked(db.task.update)).not.toHaveBeenCalled();
  });

  it("does not look for siblings when the project has no daemon binding", async () => {
    // An unbound project (e.g. the default project) can never merge, so the
    // candidate query is pure overhead.
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...baseTaskRow,
      project: { ...baseProjectRow, daemonHost: null },
    } as any);

    const response = await callPut({ label_ids: ["l1"] });
    expect(response.status).toBe(200);
    expect(vi.mocked(db.project.findMany)).not.toHaveBeenCalled();
  });
});
