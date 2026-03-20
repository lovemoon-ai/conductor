import { describe, it, expect, vi, beforeEach } from "vitest";
import { PATCH, DELETE } from "@/app/api/projects/[projectId]/route";
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

    it("should return 409 when name already exists", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: "proj-2",
        name: "Dup",
        userId: "user-1",
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "PATCH",
        token,
        body: { name: "Dup" },
      });
      const response = await PATCH(request, { params: Promise.resolve({ projectId: "proj-1" }) });
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Project name already exists");
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
        name: "Default",
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
