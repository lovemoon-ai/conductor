import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockStartNewUserPlusAccess } = vi.hoisted(() => {
  const project = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  };
  const defaultProject = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  };
  const user = {
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  const tx = {
    project,
    defaultProject,
    user,
  };

  return {
    mockDb: {
      project,
      defaultProject,
      user,
      $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
    },
    mockStartNewUserPlusAccess: vi.fn(),
  };
});

vi.mock("../db", () => ({
  db: mockDb,
}));

vi.mock("@/lib/subscription/service", () => ({
  startNewUserPlusAccess: mockStartNewUserPlusAccess,
}));

describe("self-host bootstrap auth helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.defaultProject.findUnique.mockResolvedValue(null);
    mockDb.project.findMany.mockResolvedValue([]);
  });

  it("normalizes self-host bootstrap phone numbers", async () => {
    const { normalizeSelfHostBootstrapPhone } = await import("./service");
    expect(normalizeSelfHostBootstrapPhone("  +86 13800138000  ")).toBe("+8613800138000");
  });

  it("creates a bootstrap user with default project and plus-dev access", async () => {
    const { bootstrapSelfHostUserByPhone } = await import("./service");
    mockDb.user.findUnique.mockResolvedValue(null);
    mockDb.user.create.mockResolvedValue({
      id: "user-1",
      phone: "+19990001234",
      email: null,
      passwordHash: "hash",
      passwordSalt: "salt",
    });
    mockStartNewUserPlusAccess.mockResolvedValue(undefined);
    mockDb.project.create.mockResolvedValue({
      id: "project-1",
      userId: "user-1",
      name: "Default Project",
      metadata: '{"autoCreated":true,"isDefault":true}',
    });
    mockDb.defaultProject.create.mockResolvedValue({
      id: "default-map-1",
      userId: "user-1",
      projectId: "project-1",
    });
    mockDb.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "user-1",
      phone: "+19990001234",
      email: null,
      passwordHash: "hash",
      passwordSalt: "salt",
      subscriptionStatus: "ACTIVE",
      subscriptionTier: "PLUS_DEV",
    });

    const result = await bootstrapSelfHostUserByPhone("+19990001234");

    expect(result.created).toBe(true);
    expect(result.normalizedPhone).toBe("+19990001234");
    expect(result.user.id).toBe("user-1");
    expect(mockStartNewUserPlusAccess).toHaveBeenCalledWith("user-1", expect.any(Object));
    expect(result.project.name).toBe("Default Project");
    expect(mockDb.defaultProject.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        projectId: "project-1",
      },
    });
  });

  it("reuses an existing bootstrap user and does not create a second default project", async () => {
    const { bootstrapSelfHostUserByPhone } = await import("./service");
    mockDb.user.findUnique.mockResolvedValue({
      id: "user-1",
      phone: "+18880001234",
      email: null,
    });
    mockDb.defaultProject.findUnique.mockResolvedValue({
      id: "default-map-1",
      userId: "user-1",
      projectId: "project-1",
      project: {
        id: "project-1",
        userId: "user-1",
        name: "Default Project",
        metadata: '{"autoCreated":true,"isDefault":true}',
      },
    });

    const result = await bootstrapSelfHostUserByPhone(" +18880001234 ");

    expect(result.created).toBe(false);
    expect(result.user.id).toBe("user-1");
    expect(mockDb.project.create).not.toHaveBeenCalled();
    expect(mockStartNewUserPlusAccess).not.toHaveBeenCalled();
    expect(mockDb.defaultProject.create).not.toHaveBeenCalled();
  });

  it("falls back to the existing user when a concurrent create hits a unique constraint", async () => {
    const { bootstrapSelfHostUserByPhone } = await import("./service");
    mockDb.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "user-2",
        phone: "+17770001234",
        email: null,
      });
    const uniqueError = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    mockDb.user.create.mockRejectedValue(uniqueError);
    mockDb.project.findMany.mockResolvedValue([
      {
        id: "project-2",
        userId: "user-2",
        name: "Default Project",
        metadata: '{"autoCreated":true,"isDefault":true}',
      },
    ] as any);
    mockDb.defaultProject.upsert.mockResolvedValue({
      id: "default-map-2",
      userId: "user-2",
      projectId: "project-2",
      project: {
        id: "project-2",
        userId: "user-2",
        name: "Default Project",
        metadata: '{"autoCreated":true,"isDefault":true}',
      },
    });

    const result = await bootstrapSelfHostUserByPhone("+17770001234");

    expect(result.created).toBe(false);
    expect(result.user.id).toBe("user-2");
    expect(mockDb.defaultProject.upsert).toHaveBeenCalledWith({
      where: { userId: "user-2" },
      update: { projectId: "project-2" },
      create: { userId: "user-2", projectId: "project-2" },
    });
  });

  it("rejects phones without full international format", async () => {
    const { normalizeSelfHostBootstrapPhone } = await import("./service");
    expect(() => normalizeSelfHostBootstrapPhone("13800138000")).toThrow(
      "Phone must start with '+' and include country code",
    );
  });
});
