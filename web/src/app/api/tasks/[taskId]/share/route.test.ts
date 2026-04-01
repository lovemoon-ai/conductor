import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST, DELETE } from "@/app/api/tasks/[taskId]/share/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
    sharedTask: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");

describe("/api/tasks/[taskId]/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  describe("POST", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getActiveSubscriptionUser).mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      );

      const response = await POST(
        createMockRequest({ method: "POST", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );

      expect(response.status).toBe(401);
    });

    it("returns 404 when task does not belong to user", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(null);

      const response = await POST(
        createMockRequest({ method: "POST", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );
      const data = await extractJson(response);

      expect(response.status).toBe(404);
      expect(data).toEqual({ error: "Not found" });
    });

    it("returns existing token via upsert when share already exists", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-1", projectId: "proj-1" } as any);
      vi.mocked(db.sharedTask.upsert).mockResolvedValue({
        id: "shared-1",
        taskId: "task-1",
        userId: "user-1",
        token: "existing-token-abc",
      } as any);

      const response = await POST(
        createMockRequest({ method: "POST", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: "existing-token-abc" });
      expect(db.sharedTask.upsert).toHaveBeenCalledWith({
        where: { taskId_userId: { taskId: "task-1", userId: "user-1" } },
        update: {},
        create: {
          taskId: "task-1",
          userId: "user-1",
          token: expect.any(String),
        },
      });
    });

    it("creates a new share token via upsert when none exists", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-1", projectId: "proj-1" } as any);
      vi.mocked(db.sharedTask.upsert).mockResolvedValue({
        id: "shared-1",
        taskId: "task-1",
        userId: "user-1",
        token: "new-token-xyz",
      } as any);

      const response = await POST(
        createMockRequest({ method: "POST", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: "new-token-xyz" });
    });

    it("returns 500 with structured error on db failure", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-1", projectId: "proj-1" } as any);
      vi.mocked(db.sharedTask.upsert).mockRejectedValue(new Error("Connection refused"));

      const response = await POST(
        createMockRequest({ method: "POST", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );
      const data = await extractJson(response);

      expect(response.status).toBe(500);
      expect(data).toEqual({ error: "Connection refused" });
    });
  });

  describe("DELETE", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(getActiveSubscriptionUser).mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      );

      const response = await DELETE(
        createMockRequest({ method: "DELETE", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );

      expect(response.status).toBe(401);
    });

    it("returns 404 when no share exists", async () => {
      vi.mocked(db.sharedTask.deleteMany).mockResolvedValue({ count: 0 } as any);

      const response = await DELETE(
        createMockRequest({ method: "DELETE", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );
      const data = await extractJson(response);

      expect(response.status).toBe(404);
      expect(data).toEqual({ error: "Not found" });
    });

    it("revokes share and returns 204", async () => {
      vi.mocked(db.sharedTask.deleteMany).mockResolvedValue({ count: 1 } as any);

      const response = await DELETE(
        createMockRequest({ method: "DELETE", url: "http://localhost:6152/api/tasks/task-1/share" }),
        { params: Promise.resolve({ taskId: "task-1" }) },
      );

      expect(response.status).toBe(204);
      expect(db.sharedTask.deleteMany).toHaveBeenCalledWith({
        where: { taskId: "task-1", userId: "user-1" },
      });
    });
  });
});
