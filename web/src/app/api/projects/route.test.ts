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
        metadata: null,
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue(null);
      vi.mocked(db.project.create).mockResolvedValue(mockProject);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { name: "New Project" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("proj-2");
      expect(data.name).toBe("New Project");
    });

    it("should return 409 when project name already exists", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const existingProject = {
        id: "proj-1",
        name: "Dup Project",
        userId: "user-1",
        metadata: null,
        createdAt: new Date("2024-01-01"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue(existingProject as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { name: "Dup Project" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project name already exists");
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
      vi.mocked(db.project.findFirst).mockResolvedValue(null);
      vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(db.project.findUnique).mockResolvedValue({
        id: "proj-1",
        name: "Renamed",
        userId: "user-1",
        metadata: null,
        createdAt: new Date("2024-01-01"),
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
      expect(db.project.updateMany).toHaveBeenCalledWith({
        where: { id: "proj-1", userId: "user-1" },
        data: {
          name: "Renamed",
          metadata: undefined,
        },
      });
    });

    it("should return 409 when new name already exists", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-2",
        name: "Existing",
        userId: "user-1",
        metadata: null,
        createdAt: new Date("2024-01-01"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        url: "http://localhost:6152/api/projects?projectId=proj-1",
        body: { name: "Existing" },
      });
      const response = await PATCH(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project name already exists");
    });
  });
});
