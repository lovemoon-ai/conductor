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
    });
    mockDb.deviceAuthSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(pollDeviceAuthorization("device-code-1")).resolves.toEqual({
      status: "consumed",
      message: "Authorization already completed",
    });
  });
});
