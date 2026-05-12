import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, PATCH, DELETE } from "@/app/api/projects/[projectId]/route";
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
    $transaction: vi.fn(),
    project: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    message: {
      deleteMany: vi.fn(),
    },
    agentOutbox: {
      create: vi.fn(),
    },
    defaultProject: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/tasks/task-file-storage", () => ({
  deleteTaskAttachmentDirectory: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    unbindTask: vi.fn(),
  },
}));

vi.mock("@/lib/tasks/task-stop", () => ({
  stopTaskBeforeRelaunch: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { deleteTaskAttachmentDirectory } = await import("@/lib/tasks/task-file-storage");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { stopTaskBeforeRelaunch } = await import("@/lib/tasks/task-stop");

describe("/api/projects/[projectId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === "function"
        ? callback({
            message: db.message,
            task: db.task,
            project: db.project,
            agentOutbox: db.agentOutbox,
          })
        : callback,
    );
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue(null);
    vi.mocked(db.project.findMany).mockResolvedValue([]);
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
    vi.mocked(db.task.findMany).mockResolvedValue([]);
    vi.mocked(db.agentOutbox.create).mockResolvedValue({ id: "outbox-1" } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.unbindTask).mockImplementation(() => undefined);
    vi.mocked(stopTaskBeforeRelaunch).mockResolvedValue({ ok: true } as any);
  });

  describe("GET", () => {
    it("should return null metadata when the stored JSON is invalid", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Broken Metadata",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/repo/project",
        repoRoot: "/repo/project",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: "not-json",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "GET",
        token,
        url: "http://localhost:6152/api/projects/proj-1",
      });
      const response = await GET(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.metadata).toBeNull();
      expect(data.is_default).toBe(false);
    });
  });

  describe("PATCH", () => {
    it("should return 401 when not authenticated", async () => {
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

      const request = createMockRequest({
        method: "PATCH",
        body: { name: "New Name" },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should reject changing a bound project without confirmed binding", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Bound Project",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/bound",
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        body: {
          daemonHost: "daemon-b",
          workspacePath: "/repo/other",
        },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Binding fields require confirmed binding from daemon/CLI");
    });

    it("should reject invalid metadata payloads", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Bound Project",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/bound",
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        body: {
          metadata: "oops",
        },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("metadata must be an object or null");
    });

    it("persists and serializes metadata.memos round-trip", async () => {
      // Locks in the project-memo feature's storage contract: the dialog
      // sends `metadata: { memos: [...] }` and expects the same shape back so
      // the timeline renders without a refetch.
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Memo Project",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/memo",
      } as any);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      const storedMemos = [
        { id: "m1", content: "first", createdAt: "2026-05-01T08:00:00.000Z" },
        { id: "m2", content: "second", createdAt: "2026-05-02T08:00:00.000Z" },
      ];
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Memo Project",
        daemonHost: "daemon-a",
        workspacePath: "/repo/memo",
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: JSON.stringify({ memos: storedMemos }),
        createdAt: new Date("2026-05-01"),
        updatedAt: new Date("2026-05-02"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        body: { metadata: { memos: storedMemos } },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      // The server should serialize the JSON before writing so we can verify
      // the column value rather than rely on Prisma's type coercion.
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: JSON.stringify({ memos: storedMemos }),
          }),
        }),
      );
      // And the response surfaces the parsed metadata so the client can render
      // the timeline without another fetch.
      expect(data.metadata).toEqual({ memos: storedMemos });
    });

    it("rejects multibyte metadata payloads whose UTF-8 size exceeds the cap", async () => {
      // Regression guard for the byte-vs-char trap: a CJK char encodes to
      // 3 UTF-8 bytes. With UTF-16-only accounting this payload (~100K chars
      // ≈ 300 KB UTF-8) would silently slip past the documented 256 KiB cap.
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Big Project",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/big",
      } as any);

      const token = createTestToken("user-1");
      const cjkContent = "笔".repeat(100 * 1024);
      const request = createMockRequest({
        method: "PATCH",
        token,
        body: {
          metadata: {
            memos: [
              { id: "cjk", content: cjkContent, createdAt: "2026-05-01T00:00:00.000Z" },
            ],
          },
        },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toMatch(/metadata exceeds/);
      expect(db.project.updateMany).not.toHaveBeenCalled();
    });

    it("rejects metadata payloads exceeding the size cap", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Big Project",
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/big",
      } as any);

      const token = createTestToken("user-1");
      // 300 KiB of "a"s in a single memo — comfortably over the 256 KiB cap.
      const oversizedContent = "a".repeat(300 * 1024);
      const request = createMockRequest({
        method: "PATCH",
        token,
        body: {
          metadata: {
            memos: [{ id: "big", content: oversizedContent, createdAt: "2026-05-01T00:00:00.000Z" }],
          },
        },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toMatch(/metadata exceeds/);
      // The guard must short-circuit before the DB call so a malicious payload
      // cannot bloat the row.
      expect(db.project.updateMany).not.toHaveBeenCalled();
    });

    it("should reject binding to a workspace that already belongs to another project", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-pending",
        name: "Pending Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
      } as any);
      vi.mocked(db.project.findMany).mockResolvedValue([
        {
          id: "proj-existing",
          name: "Existing Project",
          userId: "user-1",
          daemonHost: "daemon-a",
          workspacePath: "/repo/existing",
          metadata: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ] as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        body: {
          daemonHost: "daemon-a",
          workspacePath: "/repo/existing",
          bindingConfirmed: true,
        },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-pending" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project binding already exists");
      expect(db.project.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("should return 404 when project does not exist", async () => {
      const token = createTestToken("user-1");
      vi.mocked(db.project.findFirst).mockResolvedValue(null);

      const request = createMockRequest({
        method: "DELETE",
        token,
      });
      const response = await DELETE(request, { params: Promise.resolve({ projectId: "proj-missing" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(404);
      expect(data.error).toBe("Not found");
      expect(db.task.findMany).not.toHaveBeenCalled();
    });

    it("should reject deleting default project", async () => {
      const token = createTestToken("user-1");
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-default",
        name: "Default Project",
      } as any);
      vi.mocked(db.defaultProject.findUnique).mockResolvedValue({
        id: "default-map-1",
        userId: "user-1",
        projectId: "proj-default",
      } as any);

      const request = createMockRequest({
        method: "DELETE",
        token,
      });
      const response = await DELETE(request, { params: Promise.resolve({ projectId: "proj-default" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("Cannot delete default project");
      expect(db.task.findMany).not.toHaveBeenCalled();
    });

    it("should delete project with child records", async () => {
      const token = createTestToken("user-1");
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Test Project",
      } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-1",
          taskType: "ai_task",
          launchConfig: null,
          status: "completed",
        },
      ] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 2 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-1" } as any);

      const request = createMockRequest({
        method: "DELETE",
        token,
      });
      const response = await DELETE(request, { params: Promise.resolve({ projectId: "proj-1" }) });

      expect(response.status).toBe(204);
      expect(db.task.findMany).toHaveBeenCalledWith({
        where: { projectId: "proj-1" },
        select: {
          id: true,
          taskType: true,
          launchConfig: true,
          metadata: true,
          agentHost: true,
          executionHost: true,
          status: true,
        },
      });
      expect(db.message.deleteMany).toHaveBeenCalledWith({
        where: {
          taskId: {
            in: ["task-1"],
          },
        },
      });
      expect(db.task.deleteMany).toHaveBeenCalledWith({
        where: { projectId: "proj-1" },
      });
      expect(db.project.delete).toHaveBeenCalledWith({
        where: { id: "proj-1" },
      });
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-1");
      expect(db.agentOutbox.create).not.toHaveBeenCalled();
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-1");
    });

    it("should queue worktree cleanup before deleting a project with isolated worktree tasks", async () => {
      const token = createTestToken("user-1");
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Worktree Project",
        daemonHost: "daemon-offline",
      } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-worktree-1",
          launchConfig: JSON.stringify({
            worktree: true,
            worktreeId: "task-worktree-1",
            worktreeBranch: "abc123",
            worktreeBaseRef: "main",
            projectRepoRoot: "/repo",
            projectWorkspacePath: "/repo/app",
            projectRelativePath: "app",
          }),
          metadata: null,
          agentHost: "daemon-offline",
          executionHost: "daemon-offline",
          status: "completed",
        },
      ] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-1" } as any);

      const request = createMockRequest({
        method: "DELETE",
        token,
      });
      const response = await DELETE(request, { params: Promise.resolve({ projectId: "proj-1" }) });

      expect(response.status).toBe(204);
      expect(db.agentOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            agentHost: "daemon-offline",
            taskId: "task-worktree-1",
            eventType: "cleanup_task_worktree",
          }),
        }),
      );
      expect(db.task.deleteMany).toHaveBeenCalledWith({
        where: { projectId: "proj-1" },
      });
      expect(db.project.delete).toHaveBeenCalledWith({
        where: { id: "proj-1" },
      });
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-1");
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-1");
    });

    it("should skip message delete when no tasks", async () => {
      const token = createTestToken("user-1");
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-empty",
        name: "Empty Project",
      } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([]);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 0 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-empty" } as any);

      const request = createMockRequest({
        method: "DELETE",
        token,
      });
      const response = await DELETE(request, { params: Promise.resolve({ projectId: "proj-empty" }) });

      expect(response.status).toBe(204);
      expect(db.message.deleteMany).not.toHaveBeenCalled();
      expect(db.task.deleteMany).toHaveBeenCalledWith({
        where: { projectId: "proj-empty" },
      });
      expect(db.project.delete).toHaveBeenCalledWith({
        where: { id: "proj-empty" },
      });
    });

    it("should stop active worktree tasks and queue one cleanup per shared root before deleting a project", async () => {
      const token = createTestToken("user-1");
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Worktree Project",
        daemonHost: "daemon-a",
      } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-worktree-source",
          launchConfig: JSON.stringify({
            worktree: true,
            worktreeId: "task-worktree-source",
            worktreeBranch: "abc123",
            worktreeBaseRef: "main",
            projectRepoRoot: "/repo",
            projectWorkspacePath: "/repo/app",
            projectRelativePath: "app",
          }),
          metadata: JSON.stringify({ daemonName: "daemon-a" }),
          agentHost: "conductor-fire-debug-1",
          executionHost: null,
          status: "running",
        },
        {
          id: "task-worktree-successor",
          launchConfig: JSON.stringify({
            worktree: true,
            worktree_id: "task-worktree-source",
            worktree_branch: "abc123",
            worktree_base_ref: "main",
            project_repo_root: "/repo",
            project_workspace_path: "/repo/app",
            project_relative_path: "app",
          }),
          metadata: null,
          agentHost: "daemon-a",
          executionHost: "daemon-a",
          status: "completed",
        },
      ] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 2 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-1" } as any);

      const request = createMockRequest({
        method: "DELETE",
        token,
      });
      const response = await DELETE(request, { params: Promise.resolve({ projectId: "proj-1" }) });

      expect(response.status).toBe(204);
      expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          taskId: "task-worktree-source",
          projectId: "proj-1",
          stopTargetHost: "daemon-a",
          reason: "project_deleted",
          taskLabel: "task",
        }),
      );
      expect(db.agentOutbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            agentHost: "daemon-a",
            taskId: "task-worktree-source",
            eventType: "cleanup_task_worktree",
          }),
        }),
      );
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-source");
      expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-successor");
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-source");
      expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-successor");
    });
  });
});
