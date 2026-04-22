import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { POST } from "./route";
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
      findMany: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcastToApps: vi.fn(),
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");

const missingSortOrderColumnError = () =>
  new Prisma.PrismaClientKnownRequestError(
    "The column `projects.sort_order` does not exist in the current database.",
    {
      code: "P2022",
      clientVersion: "test",
    },
  );

describe("/api/projects/reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.project.findMany).mockReset();
    vi.mocked(db.project.update).mockReset();
    vi.mocked(db.$transaction).mockReset();
    vi.mocked(realtimeHub.broadcastToApps).mockReset();
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
    vi.mocked(db.project.findMany).mockResolvedValue([
      { id: "project-a", sortOrder: 0, createdAt: new Date("2026-04-10T00:00:00.000Z") },
      { id: "project-b", sortOrder: 1, createdAt: new Date("2026-04-09T00:00:00.000Z") },
      { id: "project-c", sortOrder: 2, createdAt: new Date("2026-04-08T00:00:00.000Z") },
    ] as any);
    vi.mocked(db.project.update).mockImplementation(({ where, data }: any) =>
      Promise.resolve({ id: where.id, sortOrder: data.sortOrder } as any),
    );
    vi.mocked(db.$transaction).mockImplementation(async (operations: any) => Promise.all(operations));
  });

  it("requires authentication", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

    const response = await POST(createMockRequest({
      method: "POST",
      body: { projectIds: ["project-a"] },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  it("persists a complete user project order", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });

    const response = await POST(createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: { projectIds: ["project-c", "project-a", "project-b"] },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.projectIds).toEqual(["project-c", "project-a", "project-b"]);
    expect(db.project.update).toHaveBeenCalledTimes(3);
    expect(db.project.update).toHaveBeenNthCalledWith(1, {
      where: { id: "project-c" },
      data: { sortOrder: 0 },
    });
    expect(db.project.update).toHaveBeenNthCalledWith(2, {
      where: { id: "project-a" },
      data: { sortOrder: 1 },
    });
    expect(db.project.update).toHaveBeenNthCalledWith(3, {
      where: { id: "project-b" },
      data: { sortOrder: 2 },
    });
    expect(realtimeHub.broadcastToApps).toHaveBeenCalledWith("user-1", {
      type: "projects_reordered",
      payload: {
        projectIds: ["project-c", "project-a", "project-b"],
        project_ids: ["project-c", "project-a", "project-b"],
      },
    });
  });

  it("rejects partial or stale project orders", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });

    const response = await POST(createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: { projectIds: ["project-c", "project-a"] },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe("projectIds must include every project exactly once");
    expect(db.project.update).not.toHaveBeenCalled();
  });

  it("returns a migration error when sort_order column is missing", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.project.findMany).mockRejectedValueOnce(missingSortOrderColumnError());

    const response = await POST(createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: { projectIds: ["project-c", "project-a", "project-b"] },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe("Project ordering requires database migration");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
