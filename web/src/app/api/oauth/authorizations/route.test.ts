import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";

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
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import * as authService from "@/lib/auth/service";
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
  resetSsoClientRegistryForTesting();
});

describe("/api/oauth/authorizations", () => {
  it("creates an authorization code and returns the redirect URI", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "u@example.com",
      phone: null,
    });
    mockDb.ssoAuthorizationCode.create.mockResolvedValue({});

    const { POST } = await import("./route");

    const request = createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: {
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        state: "csrf-1",
        response_type: "code",
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(typeof data.redirect_uri).toBe("string");
    expect(data.redirect_uri.startsWith(TEST_REDIRECT_URI)).toBe(true);
    expect(data.redirect_uri).toContain("code=");
    expect(data.redirect_uri).toContain("state=csrf-1");
  });

  it("returns 401 when unauthenticated", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);
    const { POST } = await import("./route");

    const request = createMockRequest({
      method: "POST",
      body: {
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        state: "x",
      },
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 403 for unknown client_id", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: null,
      phone: null,
    });

    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: {
        client_id: "not-registered",
        redirect_uri: TEST_REDIRECT_URI,
        state: "x",
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(403);
    expect(data.error).toBe("unknown_client");
  });

  it("returns 403 for unregistered redirect_uri", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: null,
      phone: null,
    });

    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: {
        client_id: TEST_CLIENT_ID,
        redirect_uri: "https://evil.example/cb",
        state: "x",
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(403);
    expect(data.error).toBe("invalid_redirect_uri");
  });

  it("returns 400 for unsupported response_type", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: null,
      phone: null,
    });

    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: {
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        state: "x",
        response_type: "token",
      },
    });
    const response = await POST(request);
    const data = await extractJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toBe("unsupported_response_type");
  });

  it("returns 400 for missing fields", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: null,
      phone: null,
    });

    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      token: createTestToken("user-1"),
      body: {},
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
