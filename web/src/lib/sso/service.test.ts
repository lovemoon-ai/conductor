import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const ssoAuthorizationCode = {
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  };
  const userToken = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  return {
    mockDb: {
      ssoAuthorizationCode,
      userToken,
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

import {
  createSsoAuthorizationCode,
  consumeSsoAuthorizationCode,
  getOrIssueConnectedAppToken,
  connectedAppTokenName,
} from "./service";
import { resetSsoClientRegistryForTesting } from "./clients";

const TEST_CLIENT_ID = "arxiv-radar";
const TEST_REDIRECT_URI = "https://arxiv-radar.example.com/api/auth/callback";
const TEST_SECRET = "test-secret";

function withTestClient(config?: Partial<{ trusted: boolean; clientSecret: string; redirectUris: string[] }>): void {
  process.env.CONDUCTOR_SSO_CLIENTS_JSON = JSON.stringify([
    {
      client_id: TEST_CLIENT_ID,
      display_name: "arxiv-radar",
      client_secret: config?.clientSecret ?? TEST_SECRET,
      redirect_uris: config?.redirectUris ?? [TEST_REDIRECT_URI],
      trusted: config?.trusted ?? true,
    },
  ]);
  resetSsoClientRegistryForTesting();
}

beforeEach(() => {
  vi.clearAllMocks();
  withTestClient();
});

afterEach(() => {
  delete process.env.CONDUCTOR_SSO_CLIENTS_JSON;
  resetSsoClientRegistryForTesting();
});

describe("createSsoAuthorizationCode", () => {
  it("creates a code and returns a redirect URI with code + state", async () => {
    mockDb.ssoAuthorizationCode.create.mockResolvedValue({});

    const result = await createSsoAuthorizationCode({
      userId: "user-1",
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
      state: "csrf-state",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mockDb.ssoAuthorizationCode.create).toHaveBeenCalledOnce();
    const createArgs = mockDb.ssoAuthorizationCode.create.mock.calls[0][0];
    expect(createArgs.data.clientId).toBe(TEST_CLIENT_ID);
    expect(createArgs.data.userId).toBe("user-1");
    expect(createArgs.data.redirectUri).toBe(TEST_REDIRECT_URI);
    expect(createArgs.data.codeHash).toBe(`hash:${result.data.code}`);
    expect(result.data.redirectUri.startsWith(TEST_REDIRECT_URI + "?code=")).toBe(true);
    expect(result.data.redirectUri).toContain("&state=csrf-state");
  });

  it("rejects unknown_client", async () => {
    const result = await createSsoAuthorizationCode({
      userId: "user-1",
      clientId: "not-registered",
      redirectUri: TEST_REDIRECT_URI,
      state: "abc",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown_client");
  });

  it("rejects invalid_redirect_uri (no prefix match)", async () => {
    const result = await createSsoAuthorizationCode({
      userId: "user-1",
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI + "/extra",
      state: "abc",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_redirect_uri");
  });

  it("rejects invalid response_type", async () => {
    const result = await createSsoAuthorizationCode({
      userId: "user-1",
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
      state: "abc",
      responseType: "token",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_response_type");
  });

  it("accepts an arbitrary redirect URI when client has no allowlist (loose mode)", async () => {
    process.env.CONDUCTOR_SSO_CLIENTS_JSON = JSON.stringify([
      {
        client_id: TEST_CLIENT_ID,
        display_name: "arxiv-radar",
        client_secret: TEST_SECRET,
      },
    ]);
    resetSsoClientRegistryForTesting();
    mockDb.ssoAuthorizationCode.create.mockResolvedValue({});

    const result = await createSsoAuthorizationCode({
      userId: "user-1",
      clientId: TEST_CLIENT_ID,
      redirectUri: "https://wherever.example/api/auth/callback",
      state: "abc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.redirectUri.startsWith("https://wherever.example/api/auth/callback")).toBe(true);
  });

  it("loose-mode still rejects non-http schemes and bad URLs", async () => {
    process.env.CONDUCTOR_SSO_CLIENTS_JSON = JSON.stringify([
      {
        client_id: TEST_CLIENT_ID,
        display_name: "arxiv-radar",
        client_secret: TEST_SECRET,
      },
    ]);
    resetSsoClientRegistryForTesting();

    for (const badUri of ["javascript:alert(1)", "ftp://x.example/", "not a url"]) {
      const result = await createSsoAuthorizationCode({
        userId: "user-1",
        clientId: TEST_CLIENT_ID,
        redirectUri: badUri,
        state: "abc",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("invalid_redirect_uri");
    }
  });

  it("appends code/state correctly when redirect URI already has a query", async () => {
    withTestClient({ redirectUris: [`${TEST_REDIRECT_URI}?foo=1`] });
    mockDb.ssoAuthorizationCode.create.mockResolvedValue({});

    const result = await createSsoAuthorizationCode({
      userId: "user-1",
      clientId: TEST_CLIENT_ID,
      redirectUri: `${TEST_REDIRECT_URI}?foo=1`,
      state: "x y",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.redirectUri).toContain("&code=");
    expect(result.data.redirectUri).toContain("&state=x%20y");
  });
});

describe("consumeSsoAuthorizationCode", () => {
  it("consumes a valid code atomically and returns the user", async () => {
    const code = "test-code-123456789";
    mockDb.ssoAuthorizationCode.findMany.mockResolvedValue([
      {
        id: "code-1",
        clientId: TEST_CLIENT_ID,
        userId: "user-42",
        redirectUri: TEST_REDIRECT_URI,
        codeHash: `hash:${code}`,
        codeSalt: "salt-1",
        codePrefix: code.slice(0, 8),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
    ]);
    mockDb.ssoAuthorizationCode.updateMany.mockResolvedValue({ count: 1 });

    const result = await consumeSsoAuthorizationCode({
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_SECRET,
      redirectUri: TEST_REDIRECT_URI,
      code,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.userId).toBe("user-42");
    expect(mockDb.ssoAuthorizationCode.updateMany).toHaveBeenCalledWith({
      where: { id: "code-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("rejects unknown client", async () => {
    const result = await consumeSsoAuthorizationCode({
      clientId: "unknown",
      clientSecret: "any",
      redirectUri: TEST_REDIRECT_URI,
      code: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown_client");
  });

  it("rejects invalid client_secret", async () => {
    const result = await consumeSsoAuthorizationCode({
      clientId: TEST_CLIENT_ID,
      clientSecret: "wrong",
      redirectUri: TEST_REDIRECT_URI,
      code: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_client_secret");
  });

  it("rejects invalid redirect_uri", async () => {
    const result = await consumeSsoAuthorizationCode({
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_SECRET,
      redirectUri: "https://evil.example/cb",
      code: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_redirect_uri");
  });

  it("rejects expired code", async () => {
    const code = "exp-code-1234567";
    mockDb.ssoAuthorizationCode.findMany.mockResolvedValue([
      {
        id: "c1",
        clientId: TEST_CLIENT_ID,
        userId: "u1",
        redirectUri: TEST_REDIRECT_URI,
        codeHash: `hash:${code}`,
        codeSalt: "salt-1",
        codePrefix: code.slice(0, 8),
        expiresAt: new Date(Date.now() - 1000),
        consumedAt: null,
      },
    ]);

    const result = await consumeSsoAuthorizationCode({
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_SECRET,
      redirectUri: TEST_REDIRECT_URI,
      code,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_code");
    expect(mockDb.ssoAuthorizationCode.updateMany).not.toHaveBeenCalled();
  });

  it("treats updateMany race loss as invalid_code", async () => {
    const code = "race-code-12345";
    mockDb.ssoAuthorizationCode.findMany.mockResolvedValue([
      {
        id: "c-race",
        clientId: TEST_CLIENT_ID,
        userId: "u-race",
        redirectUri: TEST_REDIRECT_URI,
        codeHash: `hash:${code}`,
        codeSalt: "salt-1",
        codePrefix: code.slice(0, 8),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
    ]);
    mockDb.ssoAuthorizationCode.updateMany.mockResolvedValue({ count: 0 });

    const result = await consumeSsoAuthorizationCode({
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_SECRET,
      redirectUri: TEST_REDIRECT_URI,
      code,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_code");
  });

  it("rejects code whose redirect_uri does not match the call", async () => {
    withTestClient({ redirectUris: [TEST_REDIRECT_URI, "https://other.example/cb"] });
    const code = "mismatch-code-1";
    mockDb.ssoAuthorizationCode.findMany.mockResolvedValue([
      {
        id: "c-mismatch",
        clientId: TEST_CLIENT_ID,
        userId: "u",
        redirectUri: "https://other.example/cb",
        codeHash: `hash:${code}`,
        codeSalt: "salt-1",
        codePrefix: code.slice(0, 8),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
    ]);
    const result = await consumeSsoAuthorizationCode({
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_SECRET,
      redirectUri: TEST_REDIRECT_URI,
      code,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_code");
  });
});

describe("getOrIssueConnectedAppToken", () => {
  it("reuses an existing connected-app token when present", async () => {
    mockDb.userToken.findFirst.mockResolvedValue({
      id: "t1",
      tokenValue: "existing-token-value",
      revokedAt: null,
    });

    const value = await getOrIssueConnectedAppToken("user-1", TEST_CLIENT_ID);
    expect(value).toBe("existing-token-value");
    expect(mockDb.userToken.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", name: connectedAppTokenName(TEST_CLIENT_ID), revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(mockDb.userToken.create).not.toHaveBeenCalled();
  });

  it("issues a new token when none exists", async () => {
    mockDb.userToken.findFirst.mockResolvedValue(null);
    mockDb.userToken.create.mockResolvedValue({});

    const value = await getOrIssueConnectedAppToken("user-2", TEST_CLIENT_ID);
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(20);
    expect(mockDb.userToken.create).toHaveBeenCalledOnce();
    const created = mockDb.userToken.create.mock.calls[0][0];
    expect(created.data.userId).toBe("user-2");
    expect(created.data.name).toBe(connectedAppTokenName(TEST_CLIENT_ID));
    expect(created.data.tokenValue).toBe(value);
  });

  it("issues a new token when the existing record has no tokenValue", async () => {
    mockDb.userToken.findFirst.mockResolvedValue({
      id: "t-legacy",
      tokenValue: null,
      revokedAt: null,
    });
    mockDb.userToken.create.mockResolvedValue({});

    const value = await getOrIssueConnectedAppToken("user-3", TEST_CLIENT_ID);
    expect(typeof value).toBe("string");
    expect(mockDb.userToken.create).toHaveBeenCalledOnce();
  });
});
