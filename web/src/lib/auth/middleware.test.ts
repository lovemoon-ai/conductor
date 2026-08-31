import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

import { createMockRequest } from "@/__tests__/helpers";
import { ATTACHMENT_AUTH_COOKIE_NAME } from "./token-storage";

vi.mock("./service", () => ({
  authenticateToken: vi.fn(),
}));

const shareScope = vi.hoisted(() => ({
  resolveActiveShareForToken: vi.fn(),
  isResourceInShareScope: vi.fn(),
}));

vi.mock("@/lib/daemon-share/scope", async () => {
  // Only the DB-backed pieces are stubbed; the pure path helpers stay real so
  // these tests exercise the actual allow/deny rules.
  const actual = await vi.importActual<typeof import("@/lib/daemon-share/scope")>(
    "@/lib/daemon-share/scope",
  );
  return { ...actual, ...shareScope };
});

const { getAuthUser } = await import("./middleware");
const { resolveAuthToken } = await import("./middleware");
const { authenticateToken } = await import("./service");

describe("auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authenticates bearer tokens from the authorization header", async () => {
    vi.mocked(authenticateToken).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });

    const user = await getAuthUser(
      createMockRequest({
        token: "header-token",
      }),
    );

    expect(user?.id).toBe("user-1");
    expect(authenticateToken).toHaveBeenCalledWith("header-token");
  });

  it("accepts the attachment auth cookie for protected attachment downloads", async () => {
    const token = resolveAuthToken(
      {
        headers: new Headers({
          cookie: `${ATTACHMENT_AUTH_COOKIE_NAME}=cookie-token`,
        }),
        cookies: {
          get: (name: string) =>
            name === ATTACHMENT_AUTH_COOKIE_NAME
              ? { name: ATTACHMENT_AUTH_COOKIE_NAME, value: "cookie-token" }
              : undefined,
        },
        nextUrl: {
          pathname: "/api/tasks/task-1/attachments/att-1",
        },
      } as NextRequest,
    );

    expect(token).toBe("cookie-token");
  });

  it("does not use the attachment auth cookie for unrelated routes", async () => {
    vi.mocked(authenticateToken).mockResolvedValue({
      id: "user-3",
      email: "ignored@example.com",
      phone: null,
    });

    const user = await getAuthUser(
      {
        headers: new Headers({
          cookie: `${ATTACHMENT_AUTH_COOKIE_NAME}=cookie-token`,
        }),
        cookies: {
          get: () => ({ name: ATTACHMENT_AUTH_COOKIE_NAME, value: "cookie-token" }),
        },
        nextUrl: {
          pathname: "/api/tasks",
        },
      } as NextRequest,
    );

    expect(user).toBeNull();
    expect(authenticateToken).not.toHaveBeenCalled();
  });
});

describe("daemon-share scope gate", () => {
  const shareUser = {
    id: "user-b",
    email: null,
    phone: null,
    tokenScope: "daemon_share" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateToken).mockResolvedValue(shareUser);
    shareScope.resolveActiveShareForToken.mockResolvedValue({
      shareId: "s1",
      guestHost: "shared-alice-mbp",
      granteeUserId: "user-b",
    });
    shareScope.isResourceInShareScope.mockResolvedValue(true);
  });

  it("does not refuse a non-/api path, so the SDK's prefix probe still 404s", async () => {
    // `conductor-sdk`'s backend client sends every path unprefixed first and
    // only retries with `/api` when it gets a 404. Refusing `/tasks/:id` here
    // turns that probe into a 401, the retry never fires, and fire dies with
    // `Backend responded with 401` -- which is exactly what stopped a real
    // guest task from ever reaching the AI. Falling through lets Next's router
    // 404 it the same way it would for any other credential.
    const user = await getAuthUser(
      createMockRequest({ token: "share-token", url: "http://localhost/tasks/t1" }) as NextRequest,
    );

    expect(user).not.toBeNull();
    // The share layer must not even run for a non-API path.
    expect(shareScope.resolveActiveShareForToken).not.toHaveBeenCalled();
  });

  it("still enforces the scope on /api paths", async () => {
    const allowed = await getAuthUser(
      createMockRequest({ token: "share-token", url: "http://localhost/api/tasks/t1" }) as NextRequest,
    );
    expect(allowed).not.toBeNull();

    // A route outside the allowlist is refused even though the token is valid.
    const refused = await getAuthUser(
      createMockRequest({
        token: "share-token",
        url: "http://localhost/api/auth/tokens/latest",
      }) as NextRequest,
    );
    expect(refused).toBeNull();
  });

  it("refuses when the resource is not on the share's own host", async () => {
    shareScope.isResourceInShareScope.mockResolvedValue(false);

    const user = await getAuthUser(
      createMockRequest({ token: "share-token", url: "http://localhost/api/tasks/t1" }) as NextRequest,
    );
    expect(user).toBeNull();
  });

  it("leaves full-scope tokens completely untouched", async () => {
    vi.mocked(authenticateToken).mockResolvedValue({
      id: "user-a",
      email: null,
      phone: null,
      tokenScope: "full",
    });

    const user = await getAuthUser(
      createMockRequest({
        token: "full-token",
        url: "http://localhost/api/auth/tokens/latest",
      }) as NextRequest,
    );

    expect(user).not.toBeNull();
    expect(shareScope.resolveActiveShareForToken).not.toHaveBeenCalled();
  });
});
