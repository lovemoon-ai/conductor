import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface CodexAuthInfo {
  email?: string;
  accountId?: string;
  planType?: string;
  userId?: string;
  name?: string;
  lastRefresh?: string;
  accessToken?: string;
  /**
   * Stable identity fingerprint across auth files.
   * Prefers `email|account_id` from the id_token; falls back to a hash of access_token.
   */
  identityFingerprint?: string;
}

/** Decode the JWT payload segment (no signature verification). */
function decodeJwtPayload(token: string): any {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json);
}

export function parseAuthFileContents(data: CodexAuthFile): CodexAuthInfo {
  const info: CodexAuthInfo = {};
  const tokens = data.tokens;
  if (!tokens) return info;

  info.accountId = tokens.account_id;
  info.accessToken = tokens.access_token;
  info.lastRefresh = data.last_refresh;

  if (tokens.id_token) {
    try {
      const payload = decodeJwtPayload(tokens.id_token);
      info.email = payload.email;
      info.name = payload.name;
      info.userId = payload.user_id ?? payload.sub;
      const ext = payload["https://api.openai.com/auth"];
      if (ext && typeof ext === "object") {
        info.planType = ext.chatgpt_plan_type;
        if (!info.accountId) info.accountId = ext.chatgpt_account_id;
      }
    } catch {
      // ignore malformed id_token; caller may still have an access_token
    }
  }

  info.identityFingerprint = computeIdentityFingerprint(info);
  return info;
}

function computeIdentityFingerprint(info: CodexAuthInfo): string | undefined {
  if (info.email || info.accountId) {
    return `${(info.email ?? "").toLowerCase()}|${info.accountId ?? ""}`;
  }
  if (info.accessToken) {
    return "tok:" + createHash("sha1").update(info.accessToken).digest("hex").slice(0, 16);
  }
  return undefined;
}

export async function parseAuthFile(path: string): Promise<CodexAuthInfo> {
  const raw = await readFile(path, "utf8");
  const data = JSON.parse(raw) as CodexAuthFile;
  return parseAuthFileContents(data);
}
