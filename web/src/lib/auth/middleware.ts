import { NextRequest } from "next/server";
import { authenticateToken, AuthUser } from "./service";
import { ATTACHMENT_AUTH_COOKIE_NAME } from "./token-storage";

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

  return authenticateToken(token);
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
