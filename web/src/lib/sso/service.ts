import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { hashSecret, verifySecret } from "@/lib/auth/service";
import {
  assertRedirectUri,
  getSsoClient,
  verifyClientSecret,
  type SsoClientConfig,
} from "./clients";

const SSO_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const SSO_CODE_PREFIX_LENGTH = 8;

const CONNECTED_APP_TOKEN_NAME_PREFIX = "connected-app:";

export function connectedAppTokenName(clientId: string): string {
  return `${CONNECTED_APP_TOKEN_NAME_PREFIX}${clientId}`;
}

export interface CreateSsoAuthorizationCodeInput {
  userId: string;
  clientId: string;
  redirectUri: string;
  state?: string | null;
  responseType?: string | null;
}

export type CreateSsoAuthorizationCodeError =
  | { kind: "unknown_client" }
  | { kind: "invalid_redirect_uri" }
  | { kind: "invalid_response_type" };

export interface CreateSsoAuthorizationCodeResult {
  code: string;
  redirectUri: string;
  expiresAt: Date;
  client: SsoClientConfig;
}

function buildRedirectUri(redirectUri: string, code: string, state: string | null | undefined): string {
  // We do not run redirectUri through a URL constructor first because the spec
  // requires exact match with the registered value (which may not have a
  // trailing slash, etc.). Instead append code/state with proper encoding,
  // preserving the original query string format if any.
  const separator = redirectUri.includes("?") ? "&" : "?";
  const params: string[] = [`code=${encodeURIComponent(code)}`];
  if (state !== null && state !== undefined && state !== "") {
    params.push(`state=${encodeURIComponent(state)}`);
  }
  return `${redirectUri}${separator}${params.join("&")}`;
}

function generateAuthorizationCode(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSsoAuthorizationCode(
  input: CreateSsoAuthorizationCodeInput,
): Promise<{ ok: true; data: CreateSsoAuthorizationCodeResult } | { ok: false; error: CreateSsoAuthorizationCodeError }> {
  const responseType = (input.responseType ?? "code").trim();
  if (responseType !== "code") {
    return { ok: false, error: { kind: "invalid_response_type" } };
  }

  const client = getSsoClient(input.clientId);
  if (!client) {
    return { ok: false, error: { kind: "unknown_client" } };
  }

  if (!assertRedirectUri(client, input.redirectUri)) {
    return { ok: false, error: { kind: "invalid_redirect_uri" } };
  }

  const code = generateAuthorizationCode();
  const { hash, salt } = hashSecret(code);
  const expiresAt = new Date(Date.now() + SSO_AUTHORIZATION_CODE_TTL_SECONDS * 1000);

  await db.ssoAuthorizationCode.create({
    data: {
      clientId: client.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeHash: hash,
      codeSalt: salt,
      codePrefix: code.slice(0, SSO_CODE_PREFIX_LENGTH),
      expiresAt,
    },
  });

  return {
    ok: true,
    data: {
      code,
      redirectUri: buildRedirectUri(input.redirectUri, code, input.state ?? null),
      expiresAt,
      client,
    },
  };
}

export interface ConsumeSsoAuthorizationCodeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

export type ConsumeSsoAuthorizationCodeError =
  | { kind: "unknown_client" }
  | { kind: "invalid_client_secret" }
  | { kind: "invalid_redirect_uri" }
  | { kind: "invalid_code" };

export interface ConsumeSsoAuthorizationCodeResult {
  userId: string;
  client: SsoClientConfig;
}

export async function consumeSsoAuthorizationCode(
  input: ConsumeSsoAuthorizationCodeInput,
): Promise<
  | { ok: true; data: ConsumeSsoAuthorizationCodeResult }
  | { ok: false; error: ConsumeSsoAuthorizationCodeError }
> {
  const client = getSsoClient(input.clientId);
  if (!client) {
    return { ok: false, error: { kind: "unknown_client" } };
  }

  if (!verifyClientSecret(client, input.clientSecret)) {
    return { ok: false, error: { kind: "invalid_client_secret" } };
  }

  if (!assertRedirectUri(client, input.redirectUri)) {
    return { ok: false, error: { kind: "invalid_redirect_uri" } };
  }

  const code = input.code?.trim();
  if (!code) {
    return { ok: false, error: { kind: "invalid_code" } };
  }

  const prefix = code.slice(0, SSO_CODE_PREFIX_LENGTH);
  const candidates = await db.ssoAuthorizationCode.findMany({
    where: {
      clientId: client.clientId,
      codePrefix: prefix,
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const now = new Date();
  const candidate = candidates.find((entry: (typeof candidates)[number]) => (
    entry.redirectUri === input.redirectUri
    && entry.expiresAt.getTime() > now.getTime()
    && verifySecret(code, entry.codeHash, entry.codeSalt)
  ));
  if (candidate) {
    // Attempt atomic consume; updateMany returns count to guard against races.
    const consumed = await db.ssoAuthorizationCode.updateMany({
      where: { id: candidate.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      return { ok: false, error: { kind: "invalid_code" } };
    }
    return { ok: true, data: { userId: candidate.userId, client } };
  }

  return { ok: false, error: { kind: "invalid_code" } };
}

/**
 * Returns an existing reusable token value for the given user + client_id, or
 * issues a new one. We match by token `name` convention `connected-app:<id>`.
 *
 * `tokenValue` is only populated when the token can be returned as plaintext —
 * e.g. tokens issued via this code path or the device auth flow. If an older
 * matching record exists without a tokenValue, we issue a new one instead of
 * trying to recover the original.
 */
export async function getOrIssueConnectedAppToken(userId: string, clientId: string): Promise<string> {
  const name = connectedAppTokenName(clientId);
  const existing = await db.userToken.findFirst({
    where: { userId, name, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.tokenValue) {
    return existing.tokenValue;
  }

  const rawToken = randomBytes(24).toString("hex");
  const { hash, salt } = hashSecret(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);

  await db.userToken.create({
    data: {
      userId,
      name,
      tokenHash: hash,
      tokenSalt: salt,
      tokenPrefix,
      tokenValue: rawToken,
    },
  });

  return rawToken;
}
