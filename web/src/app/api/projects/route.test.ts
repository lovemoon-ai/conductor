import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST, PATCH, DELETE } from "@/app/api/projects/route";
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
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
      findMany: vi.fn(),
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

describe("/api/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.project.findFirst).mockReset();
    vi.mocked(db.project.findMany).mockReset();
    vi.mocked(db.project.findUnique).mockReset();
    vi.mocked(db.defaultProject.findMany).mockReset();
    vi.mocked(db.defaultProject.findUnique).mockReset();
    vi.mocked(db.defaultProject.findMany).mockResolvedValue([]);
    vi.mocked(db.project.findMany).mockResolvedValue([]);
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue(null);
    vi.mocked(db.project.findFirst).mockResolvedValue(null);
    vi.mocked(db.project.findUnique).mockResolvedValue(null);
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
  });

  describe("GET", () => {
    it("should return 401 when not authenticated", async () => {
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

      const request = createMockRequest({});
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return user projects when authenticated", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProjects = [
        {
          id: "proj-1",
          name: "Project 1",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          metadata: JSON.stringify({ key: "value" }),
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ];

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findMany).mockResolvedValue(mockProjects);

      const token = createTestToken("user-1");
      const request = createMockRequest({ token });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("proj-1");
      expect(data[0].name).toBe("Project 1");
      expect(data[0].metadata).toEqual({ key: "value" });
    });
  });

  describe("POST", () => {
    it("should return 401 when not authenticated", async () => {
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

      const request = createMockRequest({
        method: "POST",
        body: { name: "New Project" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should create project when authenticated", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-2",
        name: "New Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      vi.mocked(db.project.create).mockResolvedValue(mockProject);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "New Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          bindingConfirmed: true,
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-2");
      expect(data.name).toBe("New Project");
    });

    it("should create a pending project when given a binding candidate metadata", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-pending",
        name: "Pending Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: JSON.stringify({
          bindingCandidate: {
            daemonHost: "daemon-1",
            workspacePath: "/Users/duo/ws/conductor",
          },
        }),
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.create).mockResolvedValue(mockProject);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Pending Project",
          metadata: {
            bindingCandidate: {
              daemonHost: "daemon-1",
              workspacePath: "/Users/duo/ws/conductor",
            },
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-pending");
      expect(data.daemonHost).toBeNull();
      expect(data.workspacePath).toBeNull();
      expect(data.metadata).toEqual({
        bindingCandidate: {
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
        },
      });
      expect(db.project.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Pending Project",
          daemonHost: null,
          workspacePath: null,
          metadata: JSON.stringify({
            bindingCandidate: {
              daemonHost: "daemon-1",
              workspacePath: "/Users/duo/ws/conductor",
            },
          }),
        }),
      });
    });

    it("should reject a pending binding candidate when the same workspace is already bound", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findMany).mockResolvedValue([
        {
          id: "proj-existing",
          name: "Existing Project",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          metadata: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ] as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Pending Project",
          metadata: {
            bindingCandidate: {
              daemonHost: "daemon-1",
              workspacePath: "/Users/duo/ws/conductor",
            },
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project binding already exists");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject bound project creation without confirmed binding", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Pending Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Binding fields require confirmed binding from daemon/CLI");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject metadata that is not an object or null", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Bad Metadata Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          bindingConfirmed: true,
          metadata: "oops",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("metadata must be an object or null");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject duplicate project name on the same daemon", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-existing",
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "New Project",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/other",
          bindingConfirmed: true,
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project name already exists on this daemon");
      expect(db.project.create).not.toHaveBeenCalled();
    });

    it("should reject confirmed binding without daemon host or workspace path", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          name: "Bound Project",
          bindingConfirmed: true,
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("daemonHost and workspacePath are required");
    });
  });

  describe("DELETE", () => {
    it("should return 400 when projectId is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        token,
        url: "http://localhost:6152/api/projects",
      });
      const response = await DELETE(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("projectId is required");
    });

    it("should delete project and children successfully", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({ id: "proj-1", name: "Demo" } as any);
      vi.mocked(db.task.findMany).mockResolvedValue([{ id: "task-1" }] as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.task.deleteMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.delete).mockResolvedValue({ id: "proj-1" } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
      });
      const response = await DELETE(request);

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
  });

  describe("PATCH", () => {
    it("should return 400 when projectId is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects",
        body: { name: "Renamed" },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("projectId is required");
    });

    it("should rename project successfully", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst)
        .mockResolvedValueOnce({
          id: "proj-1",
          name: "Original",
          userId: "user-1",
          daemonHost: "daemon-1",
          workspacePath: "/Users/duo/ws/conductor",
          repoRoot: "/Users/duo/ws/conductor",
          worktreeBranch: "main",
          lastCommit: "abc",
          fileCount: 10,
          metadata: null,
          createdAt: new Date("2024-01-01"),
        } as any)
        .mockResolvedValueOnce(null);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Renamed",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { name: "Renamed" },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-1");
      expect(data.name).toBe("Renamed");
      expect(db.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "proj-1", userId: "user-1" },
          data: expect.objectContaining({
            name: "Renamed",
            metadata: undefined,
          }),
        }),
      );
    });

    it("should reject changing the default project binding", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.defaultProject.findUnique).mockResolvedValue({
        id: "default-map-1",
        userId: "user-1",
        projectId: "proj-1",
      } as any);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-1",
        name: "Default Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: null,
        createdAt: new Date("2024-01-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: {
          daemonHost: "daemon-a",
          workspacePath: "/repo/new",
          bindingConfirmed: true,
        },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Default project binding cannot be changed");
    });
  });
});
