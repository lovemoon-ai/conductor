import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    user: { findUnique: vi.fn() },
    ssoAuthorizationCode: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    userToken: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

vi.mock("@/lib/auth/service", () => ({
  hashSecret: vi.fn((secret: string) => ({ hash: `hash:${secret}`, salt: "salt-1" })),
  verifySecret: vi.fn((secret: string, hash: string) => hash === `hash:${secret}`),
}));

import { resetSsoClientRegistryForTesting } from "@/lib/sso/clients";

const TEST_CLIENT_ID = "arxiv-radar";
const TEST_REDIRECT_URI = "https://arxiv-radar.example.com/api/auth/callback";
const TEST_SECRET = "test-secret";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONDUCTOR_SSO_CLIENTS_JSON = JSON.stringify([
    {
      client_id: TEST_CLIENT_ID,
      display_name: "arxiv-radar",
      client_secret: TEST_SECRET,
      redirect_uris: [TEST_REDIRECT_URI],
      trusted: true,
    },
  ]);
  resetSsoClientRegistryForTesting();
});

afterEach(() => {
  delete process.env.CONDUCTOR_SSO_CLIENTS_JSON;
  delete process.env.CONDUCTOR_PUBLIC_BASE_URL;
  resetSsoClientRegistryForTesting();
});

describe("/api/oauth/token", () => {
  it("exchanges a valid authorization_code for an access_token", async () => {
    const code = "valid-code-1234567890";
    mockDb.ssoAuthorizationCode.findMany.mockResolvedValue([
      {
        id: "c1",
        clientId: TEST_CLIENT_ID,
        userId: "user-1",
        redirectUri: TEST_REDIRECT_URI,
        codeHash: `hash:${code}`,
        codeSalt: "salt-1",
        codePrefix: code.slice(0, 8),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
    ]);
    mockDb.ssoAuthorizationCode.updateMany.mockResolvedValue({ count: 1 });
    mockDb.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "u@example.com",
      phone: null,
    });
    mockDb.userToken.findFirst.mockResolvedValue(null);
    mockDb.userToken.create.mockResolvedValue({});

    process.env.CONDUCTOR_PUBLIC_BASE_URL = "https://conductor-ai.top";

    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_SECRET,
        code,
        redirect_uri: TEST_REDIRECT_URI,
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(data.token_type).toBe("Bearer");
    expect(typeof data.access_token).toBe("string");
    expect(data.user.id).toBe("user-1");
    expect(data.user.email).toBe("u@example.com");
    expect(data.conductor_base_url).toBe("https://conductor-ai.top");
  });

  it("rejects unsupported grant_type", async () => {
    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      body: {
        grant_type: "password",
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_SECRET,
        code: "x",
        redirect_uri: TEST_REDIRECT_URI,
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toBe("unsupported_grant_type");
  });

  it("rejects invalid client_secret", async () => {
    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: TEST_CLIENT_ID,
        client_secret: "wrong",
        code: "x",
        redirect_uri: TEST_REDIRECT_URI,
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(401);
    expect(data.error).toBe("invalid_client");
  });

  it("rejects unknown client_id", async () => {
    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: "not-registered",
        client_secret: "anything",
        code: "x",
        redirect_uri: TEST_REDIRECT_URI,
      },
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("rejects unregistered redirect_uri", async () => {
    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_SECRET,
        code: "x",
        redirect_uri: "https://evil.example/cb",
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects invalid or expired authorization code", async () => {
    mockDb.ssoAuthorizationCode.findMany.mockResolvedValue([]);
    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_SECRET,
        code: "missing-code-1234567",
        redirect_uri: TEST_REDIRECT_URI,
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects when authorization code can only be consumed once", async () => {
    const code = "race-code-1234567";
    mockDb.ssoAuthorizationCode.findMany
      .mockResolvedValueOnce([
        {
          id: "c1",
          clientId: TEST_CLIENT_ID,
          userId: "user-1",
          redirectUri: TEST_REDIRECT_URI,
          codeHash: `hash:${code}`,
          codeSalt: "salt-1",
          codePrefix: code.slice(0, 8),
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ])
      .mockResolvedValueOnce([]); // already consumed -> excluded by consumedAt: null filter
    mockDb.ssoAuthorizationCode.updateMany.mockResolvedValueOnce({ count: 1 });
    mockDb.user.findUnique.mockResolvedValue({ id: "user-1", email: null, phone: "+8613800138000" });
    mockDb.userToken.findFirst.mockResolvedValue(null);
    mockDb.userToken.create.mockResolvedValue({});

    const { POST } = await import("./route");
    const buildRequest = () =>
      createMockRequest({
        method: "POST",
        body: {
          grant_type: "authorization_code",
          client_id: TEST_CLIENT_ID,
          client_secret: TEST_SECRET,
          code,
          redirect_uri: TEST_REDIRECT_URI,
        },
      });

    const ok = await POST(buildRequest());
    expect(ok.status).toBe(200);

    const replay = await POST(buildRequest());
    const replayData = await extractJson(replay);
    expect(replay.status).toBe(400);
    expect(replayData.error).toBe("invalid_grant");
  });
});
