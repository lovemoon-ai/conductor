import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeToken = {
  id: string;
  userId: string;
  name: string | null;
  scope: string;
  tokenValue: string | null;
  tokenPrefix: string;
  tokenHash: string;
  tokenSalt: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

const { mockDb } = vi.hoisted(() => {
  const userToken = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const user = {
    findUnique: vi.fn(),
  };
  return { mockDb: { userToken, user } };
});

vi.mock("../db", () => ({
  db: mockDb,
}));

vi.mock("@/lib/verification/resend-email", () => ({ sendVerificationEmail: vi.fn() }));
vi.mock("@/lib/verification/volc-sms", () => ({ sendVerificationSms: vi.fn() }));
vi.mock("@/lib/subscription/service", () => ({ startNewUserPlusAccess: vi.fn() }));
vi.mock("@/lib/invite/service", () => ({
  findInviterByCode: vi.fn(),
  applyInviteRegisterRewardPolicy: vi.fn(),
}));

const loadService = () => import("./service");

/**
 * A `daemon_share` token minted *after* this user's `full` token: the ordering
 * that makes an unfiltered "latest non-revoked token" query pick the wrong row.
 *
 * `tokenValue` is deliberately populated here even though `issueApiToken` now
 * stores `null` for scoped tokens, so these tests prove the *scope filter* is
 * what protects the caller, not the missing plaintext.
 */
function buildTokenTable(): FakeToken[] {
  return [
    {
      id: "token-share",
      userId: "user-1",
      name: "daemon-share",
      scope: "daemon_share",
      tokenValue: "share-token-value",
      tokenPrefix: "sharepre",
      tokenHash: "share-hash",
      tokenSalt: "share-salt",
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date("2026-08-30T00:00:00.000Z"),
    },
    {
      id: "token-full",
      userId: "user-1",
      name: "laptop",
      scope: "full",
      tokenValue: "full-token-value",
      tokenPrefix: "fullpref",
      tokenHash: "full-hash",
      tokenSalt: "full-salt",
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  ];
}

/** Minimal `where` matcher: only the keys the service actually passes. */
function selectTokens(rows: FakeToken[], where: Record<string, unknown>): FakeToken[] {
  return rows
    .filter((row) => {
      if (where.userId !== undefined && row.userId !== where.userId) return false;
      if (where.revokedAt === null && row.revokedAt !== null) return false;
      if (where.scope !== undefined && row.scope !== where.scope) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function stubTokenTable(rows: FakeToken[]) {
  mockDb.userToken.findFirst.mockImplementation(async ({ where }: any) => selectTokens(rows, where)[0] ?? null);
  mockDb.userToken.findMany.mockImplementation(async ({ where }: any) => selectTokens(rows, where));
}

describe("auth service token scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getLatestTokenValue", () => {
    it("skips a newer daemon_share token and returns the full one", async () => {
      const { getLatestTokenValue } = await loadService();
      stubTokenTable(buildTokenTable());

      await expect(getLatestTokenValue("user-1")).resolves.toBe("full-token-value");
      expect(mockDb.userToken.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1", revokedAt: null, scope: "full" },
        }),
      );
    });

    it("returns null when the user only has a daemon_share token", async () => {
      const { getLatestTokenValue } = await loadService();
      stubTokenTable(buildTokenTable().filter((token) => token.scope === "daemon_share"));

      await expect(getLatestTokenValue("user-1")).resolves.toBeNull();
    });
  });

  describe("listTokens", () => {
    it("omits daemon_share tokens from the account token list", async () => {
      const { listTokens } = await loadService();
      stubTokenTable(buildTokenTable());

      const tokens = await listTokens("user-1");
      expect(tokens.map((token) => token.id)).toEqual(["token-full"]);
    });
  });

  describe("issueApiToken", () => {
    it("defaults to the full scope and stores the raw token", async () => {
      const { issueApiToken } = await loadService();
      mockDb.userToken.create.mockResolvedValue({ id: "token-new", createdAt: new Date() });

      const result = await issueApiToken("user-1", "config");

      const { data } = mockDb.userToken.create.mock.calls[0][0];
      expect(data.scope).toBe("full");
      expect(data.tokenValue).toBe(result.token);
    });

    it("does not persist the raw value of a scoped token", async () => {
      const { issueApiToken } = await loadService();
      mockDb.userToken.create.mockResolvedValue({ id: "token-new", createdAt: new Date() });

      const result = await issueApiToken("user-1", "daemon-share", "daemon_share");

      const { data } = mockDb.userToken.create.mock.calls[0][0];
      expect(data.scope).toBe("daemon_share");
      expect(data.tokenValue).toBeNull();
      expect(result.token).toMatch(/^[0-9a-f]{48}$/);
    });
  });

  describe("authenticateToken", () => {
    it("reports the stored scope for an opaque token", async () => {
      const { authenticateToken, hashSecret } = await loadService();
      const rawToken = "a".repeat(48);
      const { hash, salt } = hashSecret(rawToken);
      mockDb.userToken.findMany.mockResolvedValue([
        {
          id: "token-share",
          scope: "daemon_share",
          tokenHash: hash,
          tokenSalt: salt,
          user: { id: "user-1", email: "a@example.com", phone: null },
        },
      ]);
      mockDb.userToken.update.mockResolvedValue({});

      await expect(authenticateToken(rawToken)).resolves.toEqual({
        id: "user-1",
        email: "a@example.com",
        phone: null,
        tokenScope: "daemon_share",
      });
    });

    it("reports full for a normal opaque token", async () => {
      const { authenticateToken, hashSecret } = await loadService();
      const rawToken = "b".repeat(48);
      const { hash, salt } = hashSecret(rawToken);
      mockDb.userToken.findMany.mockResolvedValue([
        {
          id: "token-full",
          scope: "full",
          tokenHash: hash,
          tokenSalt: salt,
          user: { id: "user-1", email: null, phone: "+8613000000000" },
        },
      ]);
      mockDb.userToken.update.mockResolvedValue({});

      await expect(authenticateToken(rawToken)).resolves.toMatchObject({ tokenScope: "full" });
    });

    it("reports full for a browser JWT session", async () => {
      const { authenticateToken, signJwt } = await loadService();
      mockDb.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", phone: null });

      await expect(authenticateToken(signJwt("user-1"))).resolves.toEqual({
        id: "user-1",
        email: "a@example.com",
        phone: null,
        tokenScope: "full",
      });
      expect(mockDb.userToken.findMany).not.toHaveBeenCalled();
    });
  });
});
