import { NextRequest } from "next/server";
import { authenticateToken, AuthUser } from "./service";
import { ATTACHMENT_AUTH_COOKIE_NAME } from "./token-storage";
import {
  isDaemonShareUser,
  isPathAllowedForDaemonShare,
  isResourceInShareScope,
  normalizeSharePath,
  resolveActiveShareForToken,
} from "@/lib/daemon-share/scope";

const ATTACHMENT_DOWNLOAD_PATH = /^\/api\/tasks\/[^/]+\/attachments\/[^/]+$/;

function readCookieHeaderValue(request: NextRequest, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }
  for (const entry of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = entry.trim().split("=");
    if (rawKey !== name || rawValue.length === 0) {
      continue;
    }
    const value = rawValue.join("=").trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function getAuthorizationToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  const [, token] = authHeader.split(" ");
  return token || null;
}

function getAttachmentCookieToken(request: NextRequest): string | null {
  if (!ATTACHMENT_DOWNLOAD_PATH.test(request.nextUrl.pathname)) {
    return null;
  }
  const token =
    request.cookies.get(ATTACHMENT_AUTH_COOKIE_NAME)?.value ||
    readCookieHeaderValue(request, ATTACHMENT_AUTH_COOKIE_NAME);
  return token && token.trim() ? token.trim() : null;
}

export function resolveAuthToken(request: NextRequest): string | null {
  return getAuthorizationToken(request) || getAttachmentCookieToken(request);
}

export async function getAuthUser(request: NextRequest): Promise<AuthUser | null> {
  const token = resolveAuthToken(request);
  if (!token) return null;

  const user = await authenticateToken(token);
  if (!user) return null;

  // RFC 0035: a `daemon_share` token lives on someone else's machine, so it is
  // confined to the handful of routes a daemon actually calls. Returning null
  // (rather than throwing) makes it look like a plain auth failure to every
  // existing caller, so no route needs to know this rule exists.
  //
  // `full` tokens and JWTs never enter this branch — the scope is absent or
  // "full" for every credential minted before sharing shipped.
  if (isDaemonShareUser(user)) {
    // Normalize ONCE and hand the same string to both layers. When the
    // allowlist normalized and the resource check did not, `/api/tasks//x` and
    // `/api/TASKS/x` passed the first and matched nothing in the second --
    // layered defence on paper, a gap in practice.
    const pathname = normalizeSharePath(request.nextUrl.pathname);
    if (pathname === null) return null;

    // Only API routes are in scope. The SDK probes every path unprefixed first
    // and retries with `/api` on 404 (`shouldRetryWithApiPrefix` in
    // conductor-sdk's backend client) -- so refusing `/tasks/:id` here turns
    // that probe's expected 404 into a 401, the retry never fires, and fire
    // dies mid-task with `Backend responded with 401`. Verified live: this is
    // exactly what stopped a guest task from ever reaching the AI.
    //
    // Falling through is safe: nothing outside `/api` authenticates via
    // `getAuthUser`, so a non-API path reaches Next's router and 404s the same
    // way it does for any other credential.
    if (!pathname.startsWith("/api/") && pathname !== "/api") return user;

    if (!isPathAllowedForDaemonShare(pathname)) return null;

    // Layer 4: the resource itself must live on this share's guest host.
    // Path allowlisting alone would still let the credential -- which sits on
    // the machine owner's disk -- act on the grantee's *other* daemons.
    const binding = await resolveActiveShareForToken(token, user.id);
    if (!binding) return null;

    // Reading the body here is safe: route handlers get a fresh clone, and
    // `NextRequest` bodies are only consumed once per instance.
    //
    // Skipped only for multipart, which is the one shape that is both
    // expensive to buffer (attachment uploads) and impossible for a route to
    // read as JSON anyway. Deliberately NOT gated on "content-type is JSON":
    // `request.json()` in a route handler ignores the header, so trusting it
    // here would let `content-type: text/plain` carry a JSON body past this
    // check and straight into a route that parses it.
    let body: unknown = null;
    const isMultipart = (request.headers.get("content-type") || "")
      .toLowerCase()
      .includes("multipart/form-data");
    if (request.method !== "GET" && request.method !== "HEAD" && !isMultipart) {
      body = await request
        .clone()
        .json()
        .catch(() => null);
    }
    if (!(await isResourceInShareScope(binding, pathname, body))) return null;
  }

  return user;
}

export async function getActiveSubscriptionUser(
  request: NextRequest
): Promise<AuthUser | Response> {
  const user = await getAuthUser(request);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  return user;
}

export function requireAuth(handler: (request: NextRequest, user: AuthUser) => Promise<Response>) {
  return async (request: NextRequest) => {
    const user = await getAuthUser(request);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    return handler(request, user);
  };
}

export function requireActiveSubscription(handler: (request: NextRequest, user: AuthUser) => Promise<Response>) {
  return async (request: NextRequest) => {
    const result = await getActiveSubscriptionUser(request);
    if (result instanceof Response) {
      return result;
    }
    return handler(request, result);
  };
}
