import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const deviceAuthSession = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const userToken = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  const tx = {
    deviceAuthSession,
    userToken,
  };
  return {
    mockDb: {
      deviceAuthSession,
      userToken,
      $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(tx)),
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
}));

vi.mock("@/lib/auth/service", () => ({
  hashSecret: vi.fn((secret: string) => ({ hash: `hash:${secret}`, salt: "salt-1" })),
  verifySecret: vi.fn((secret: string, hash: string) => hash === `hash:${secret}`),
}));

describe("device auth service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prevents a second account from overwriting an existing approval", async () => {
    const { approveDeviceAuthorization } = await import("./device-auth");

    mockDb.deviceAuthSession.findUnique
      .mockResolvedValueOnce({
        id: "session-1",
        userCode: "ABCD-EFGH",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        hostname: "mac-studio",
      })
      .mockResolvedValueOnce({
        id: "session-1",
        userCode: "ABCD-EFGH",
        status: "approved",
        approvedByUserId: "user-2",
        issuedUserTokenId: "token-2",
        expiresAt: new Date(Date.now() + 60_000),
      });
    mockDb.userToken.findFirst.mockResolvedValue({
      id: "token-1",
      tokenValue: "token-value-1",
      revokedAt: null,
    });
    mockDb.deviceAuthSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(approveDeviceAuthorization("ABCD-EFGH", "user-1")).rejects.toThrow(
      "Device authorization already approved by another account",
    );
  });

  it("returns consumed instead of reissuing the token when another poll already consumed it", async () => {
    const { pollDeviceAuthorization } = await import("./device-auth");

    mockDb.deviceAuthSession.findMany.mockResolvedValue([
      {
        id: "session-1",
        deviceCodeHash: "hash:device-code-1",
        deviceCodeSalt: "salt-1",
        deviceCodePrefix: "device-code-",
        status: "approved",
        issuedUserTokenId: "token-1",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    mockDb.userToken.findUnique.mockResolvedValue({
      id: "token-1",
      tokenValue: "agent-token-1",
      revokedAt: null,
      scope: "full",
    });
    mockDb.deviceAuthSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(pollDeviceAuthorization("device-code-1")).resolves.toEqual({
      status: "consumed",
      message: "Authorization already completed",
    });
  });
  it("reuses the user's full token and ignores a newer daemon_share token", async () => {
    const { approveDeviceAuthorization } = await import("./device-auth");

    // Newest first: without a scope filter the share token wins, and `conductor
    // config` would hand a restricted token to a brand-new machine.
    const rows = [
      {
        id: "token-share",
        scope: "daemon_share",
        tokenValue: "share-token-value",
        revokedAt: null,
        createdAt: new Date("2026-08-30T00:00:00.000Z"),
      },
      {
        id: "token-full",
        scope: "full",
        tokenValue: "full-token-value",
        revokedAt: null,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ];

    mockDb.deviceAuthSession.findUnique.mockResolvedValueOnce({
      id: "session-1",
      userCode: "ABCD-EFGH",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      hostname: "mac-studio",
    });
    mockDb.userToken.findFirst.mockImplementation(async ({ where }: any) =>
      rows.find((row) => where.scope === undefined || row.scope === where.scope) ?? null,
    );
    mockDb.deviceAuthSession.updateMany.mockResolvedValue({ count: 1 });

    await expect(approveDeviceAuthorization("ABCD-EFGH", "user-1")).resolves.toEqual({
      status: "approved",
    });

    expect(mockDb.userToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", revokedAt: null, scope: "full" },
      }),
    );
    expect(mockDb.userToken.create).not.toHaveBeenCalled();
    expect(mockDb.deviceAuthSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issuedUserTokenId: "token-full" }),
      }),
    );
  });

  it("mints a fresh token when the user only has a daemon_share token", async () => {
    const { approveDeviceAuthorization } = await import("./device-auth");

    mockDb.deviceAuthSession.findUnique.mockResolvedValueOnce({
      id: "session-1",
      userCode: "ABCD-EFGH",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      hostname: "mac-studio",
    });
    // The scope filter leaves nothing to reuse.
    mockDb.userToken.findFirst.mockResolvedValue(null);
    mockDb.userToken.create.mockResolvedValue({ id: "token-new" });
    mockDb.deviceAuthSession.updateMany.mockResolvedValue({ count: 1 });

    await expect(approveDeviceAuthorization("ABCD-EFGH", "user-1")).resolves.toEqual({
      status: "approved",
    });
    expect(mockDb.deviceAuthSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issuedUserTokenId: "token-new" }),
      }),
    );
  });

  it("refuses to hand out an approved token that is not full-scope", async () => {
    const { pollDeviceAuthorization } = await import("./device-auth");

    mockDb.deviceAuthSession.findMany.mockResolvedValue([
      {
        id: "session-1",
        deviceCodeHash: "hash:device-code-1",
        deviceCodeSalt: "salt-1",
        deviceCodePrefix: "device-code-",
        status: "approved",
        issuedUserTokenId: "token-share",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    mockDb.userToken.findUnique.mockResolvedValue({
      id: "token-share",
      tokenValue: "share-token-value",
      revokedAt: null,
      scope: "daemon_share",
    });

    await expect(pollDeviceAuthorization("device-code-1")).rejects.toThrow(
      "Authorized device token is unavailable",
    );
    expect(mockDb.deviceAuthSession.updateMany).not.toHaveBeenCalled();
  });
});
