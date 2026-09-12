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

  it("does not buffer the body of a raw-body upload route", async () => {
    // The host-redirect scan JSON-parses the body of every non-GET request
    // from a share token. On `.../files/<id>/content` that body is a whole
    // file: buffering it pulls it into the shared backend's heap — twice,
    // because `clone()` tees while the route has not started reading — which
    // is exactly what the transfer design exists to avoid.
    const request = createMockRequest({
      method: "PUT",
      token: "share-token",
      url: "http://localhost/api/agents/shared-alice-mbp/files/abc-123/content",
    });
    const clone = vi.spyOn(request, "clone");

    const user = await getAuthUser(request as NextRequest);

    expect(user).toEqual(shareUser);
    expect(clone).not.toHaveBeenCalled();
    // Skipping the scan is safe only because the host came from the URL, and
    // that is still checked.
    expect(shareScope.isResourceInShareScope).toHaveBeenCalledWith(
      expect.anything(),
      "/api/agents/shared-alice-mbp/files/abc-123/content",
      null,
    );
  });

  it("does not buffer the body of the singular transfer upload route", async () => {
    // `cli/src/remote-file-handlers.js` pushes chunks to this form, not the
    // per-daemon one. It was missing from RAW_BODY_PATHS, so every 32 MiB chunk
    // was cloned and JSON-buffered on the way through.
    const request = createMockRequest({
      method: "PUT",
      token: "share-token",
      url: "http://localhost/api/agent/files/abc-123/content",
    });
    const clone = vi.spyOn(request, "clone");

    await getAuthUser(request as NextRequest);

    expect(clone).not.toHaveBeenCalled();
  });

  it("still buffers the body of an ordinary JSON route", async () => {
    const request = createMockRequest({
      method: "POST",
      token: "share-token",
      url: "http://localhost/api/tasks",
      body: { projectId: "p1" },
    });
    const clone = vi.spyOn(request, "clone");

    await getAuthUser(request as NextRequest);

    expect(clone).toHaveBeenCalled();
  });

  it("does not refuse a path no rewrite claims, so the SDK's prefix probe still 404s", async () => {
    // `conductor-sdk`'s backend client sends every path unprefixed first and
    // only retries with `/api` when it gets a 404. Refusing such a probe here
    // turns it into a 401, the retry never fires, and fire dies with
    // `Backend responded with 401` -- which is exactly what stopped a real
    // guest task from ever reaching the AI. Falling through lets Next's router
    // 404 it the same way it would for any other credential.
    const user = await getAuthUser(
      createMockRequest({ token: "share-token", url: "http://localhost/nope/t1" }) as NextRequest,
    );

    expect(user).not.toBeNull();
    // The share layer must not even run for a path that is not served here.
    expect(shareScope.resolveActiveShareForToken).not.toHaveBeenCalled();
  });

  it("enforces the scope on the unprefixed alias of an /api route", async () => {
    // `next.config.ts` rewrites `/tasks/:path*` to `/api/tasks/:path*`, but Next
    // restores the pre-rewrite URL before the handler runs, so `nextUrl.pathname`
    // reads `/tasks/t1`. Gating on that raw value let a share token reach the
    // real route with every scope check skipped -- so the alias must be resolved
    // before any decision, not treated as an unserved path.
    shareScope.isResourceInShareScope.mockResolvedValue(false);

    const user = await getAuthUser(
      createMockRequest({ token: "share-token", url: "http://localhost/tasks/t1" }) as NextRequest,
    );

    expect(user).toBeNull();
    // The resolved `/api/...` form is what the host-pinning check must see.
    expect(shareScope.isResourceInShareScope).toHaveBeenCalledWith(
      expect.objectContaining({ guestHost: "shared-alice-mbp" }),
      "/api/tasks/t1",
      null,
    );
  });

  it("refuses an unprefixed alias the allowlist withholds", async () => {
    // `/api/auth/tokens/latest` hands out credentials and is denied for share
    // tokens; `/auth/tokens/latest` must be denied identically.
    const user = await getAuthUser(
      createMockRequest({
        token: "share-token",
        url: "http://localhost/auth/tokens/latest",
      }) as NextRequest,
    );

    expect(user).toBeNull();
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
