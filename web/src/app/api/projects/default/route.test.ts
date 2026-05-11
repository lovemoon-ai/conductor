import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/projects/default/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return {
    ...mod,
    checkAndUpdateExpiredSubscription: vi.fn(),
  };
});

vi.mock("@/lib/db", () => {
  const project = { findUnique: vi.fn() };
  const defaultProject = { upsert: vi.fn() };
  const user = { findUnique: vi.fn() };
  // The route wraps the read+upsert in `db.$transaction(async (tx) => ...)`.
  // For the unit test we replay the inner closure against the same mocks; a
  // full Prisma transaction client would just wrap the same methods.
  const $transaction = vi.fn(async (cb: (tx: any) => any) =>
    cb({ project, defaultProject }),
  );
  return {
    db: {
      project,
      defaultProject,
      user,
      $transaction,
    },
  };
});

const { db } = await import("@/lib/db");

describe("POST /api/projects/default", () => {
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

  const authedAs = (userId: string) => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: userId,
      email: "test@example.com",
      phone: null,
    } as any);
    return createTestToken(userId);
  };

  it("returns 401 when not authenticated", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);
    const request = createMockRequest({ method: "POST", body: { projectId: "p-1" } });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 400 when projectId missing", async () => {
    const token = authedAs("user-1");
    const request = createMockRequest({ method: "POST", token, body: {} });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toBe("projectId is required");
  });

  it("returns 404 when project does not belong to user", async () => {
    const token = authedAs("user-1");
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p-1",
      userId: "user-2",
      name: "Other",
      hiddenAt: null,
    } as any);
    const request = createMockRequest({ method: "POST", token, body: { projectId: "p-1" } });
    const response = await POST(request);
    expect(response.status).toBe(404);
    expect(db.defaultProject.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when target project is hidden", async () => {
    const token = authedAs("user-1");
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p-1",
      userId: "user-1",
      name: "Hidden",
      hiddenAt: new Date(),
    } as any);
    const request = createMockRequest({ method: "POST", token, body: { projectId: "p-1" } });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toBe("Hidden project cannot be set as default");
    expect(db.defaultProject.upsert).not.toHaveBeenCalled();
  });

  it("upserts mapping and returns the serialized project as default", async () => {
    const token = authedAs("user-1");
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p-1",
      userId: "user-1",
      name: "My project",
      hiddenAt: null,
      daemonHost: null,
      workspacePath: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.mocked(db.defaultProject.upsert).mockResolvedValue({} as any);

    const request = createMockRequest({ method: "POST", token, body: { projectId: "p-1" } });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.id).toBe("p-1");
    expect(data.is_default).toBe(true);
    expect(db.defaultProject.upsert).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      update: { projectId: "p-1" },
      create: { userId: "user-1", projectId: "p-1" },
    });
    // Hidden-check + upsert are wrapped in a transaction (review H4).
    expect((db as any).$transaction).toHaveBeenCalledTimes(1);
  });

  it("accepts snake_case project_id", async () => {
    const token = authedAs("user-1");
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p-2",
      userId: "user-1",
      name: "Other",
      hiddenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.mocked(db.defaultProject.upsert).mockResolvedValue({} as any);
    const request = createMockRequest({ method: "POST", token, body: { project_id: "p-2" } });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(db.defaultProject.upsert).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      update: { projectId: "p-2" },
      create: { userId: "user-1", projectId: "p-2" },
    });
  });
});
