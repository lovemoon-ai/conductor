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
    defaultProject: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/conductor/task-file-storage", () => ({
  deleteTaskAttachmentDirectory: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { deleteTaskAttachmentDirectory } = await import("@/lib/conductor/task-file-storage");

describe("/api/projects/[projectId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      vi.mocked(db.task.findMany).mockResolvedValue([{ id: "task-1" }] as any);
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
        select: { id: true },
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
  });
});
