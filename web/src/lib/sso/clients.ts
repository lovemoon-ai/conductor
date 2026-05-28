import { timingSafeEqual } from "crypto";
import { verifySecret } from "@/lib/auth/service";

export interface SsoClientConfig {
  clientId: string;
  displayName: string;
  redirectUris: string[];
  trusted: boolean;
  // One of clientSecret or clientSecretHash should be provided.
  clientSecret?: string;
  clientSecretHash?: string;
  clientSecretSalt?: string;
}

interface RawClientEntry {
  client_id?: unknown;
  clientId?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  redirect_uris?: unknown;
  redirectUris?: unknown;
  client_secret?: unknown;
  clientSecret?: unknown;
  client_secret_hash?: unknown;
  clientSecretHash?: unknown;
  client_secret_salt?: unknown;
  clientSecretSalt?: unknown;
  trusted?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const normalized = typeof entry === "string" ? entry.trim() : "";
    return normalized.length > 0 ? [normalized] : [];
  });
}

function normalize(raw: RawClientEntry): SsoClientConfig | null {
  const clientId = asString(raw.client_id ?? raw.clientId);
  if (!clientId) return null;
  const displayName = asString(raw.display_name ?? raw.displayName) ?? clientId;
  const redirectUris = asStringArray(raw.redirect_uris ?? raw.redirectUris);
  const clientSecret = asString(raw.client_secret ?? raw.clientSecret);
  const clientSecretHash = asString(raw.client_secret_hash ?? raw.clientSecretHash);
  const clientSecretSalt = asString(raw.client_secret_salt ?? raw.clientSecretSalt);
  // Require some form of client secret so unconfigured clients cannot be
  // exchanged for tokens silently.
  if (!clientSecret && !(clientSecretHash && clientSecretSalt)) {
    console.error(
      `SSO client '${clientId}' has no client_secret or client_secret_hash+salt; skipping.`,
    );
    return null;
  }
  const trustedRaw = raw.trusted;
  const trusted = trustedRaw === true || trustedRaw === "true";
  if (redirectUris.length === 0) {
    console.warn(
      `SSO client '${clientId}' has no redirect_uris allowlist; ` +
        `accepting any redirect_uri presented at /oauth/authorize. ` +
        `This relies on client_secret being the only protection and turns ` +
        `Conductor's /oauth/authorize into an open redirector — only use ` +
        `this if you understand the risk.`,
    );
  }
  return {
    clientId,
    displayName,
    redirectUris,
    trusted,
    clientSecret,
    clientSecretHash,
    clientSecretSalt,
  };
}

let cachedRawJson: string | null | undefined;
let cachedRegistry: Map<string, SsoClientConfig> | null = null;

export function parseSsoClientsJson(rawJson: string | null | undefined): Map<string, SsoClientConfig> {
  const registry = new Map<string, SsoClientConfig>();
  if (!rawJson) {
    return registry;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    console.error("Failed to parse CONDUCTOR_SSO_CLIENTS_JSON", error);
    return registry;
  }
  if (!Array.isArray(parsed)) {
    console.error("CONDUCTOR_SSO_CLIENTS_JSON must be a JSON array");
    return registry;
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const client = normalize(entry as RawClientEntry);
    if (!client) continue;
    if (registry.has(client.clientId)) {
      console.error(`Duplicate SSO client_id '${client.clientId}' in CONDUCTOR_SSO_CLIENTS_JSON`);
      continue;
    }
    registry.set(client.clientId, client);
  }
  return registry;
}

function loadRegistry(): Map<string, SsoClientConfig> {
  const raw = process.env.CONDUCTOR_SSO_CLIENTS_JSON ?? null;
  if (cachedRegistry && cachedRawJson === raw) {
    return cachedRegistry;
  }
  cachedRegistry = parseSsoClientsJson(raw);
  cachedRawJson = raw;
  return cachedRegistry;
}

/**
 * Reset the in-memory client registry. Tests call this after mutating
 * process.env.CONDUCTOR_SSO_CLIENTS_JSON.
 */
export function resetSsoClientRegistryForTesting(): void {
  cachedRegistry = null;
  cachedRawJson = undefined;
}

export function getSsoClient(clientId: string | null | undefined): SsoClientConfig | null {
  if (!clientId) return null;
  return loadRegistry().get(clientId) ?? null;
}

export function listSsoClients(): SsoClientConfig[] {
  return Array.from(loadRegistry().values());
}

export function assertRedirectUri(client: SsoClientConfig, redirectUri: string | null | undefined): boolean {
  if (!redirectUri) return false;
  if (client.redirectUris.length === 0) {
    // No allowlist configured for this client — accept any syntactically valid
    // absolute http(s) URL. `code` is still bound to this URI in the database,
    // so token exchange must replay the same value.
    try {
      const parsed = new URL(redirectUri);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  // exact match only; no prefix matching.
  return client.redirectUris.includes(redirectUri);
}

export function verifyClientSecret(client: SsoClientConfig, providedSecret: string | null | undefined): boolean {
  if (!providedSecret) return false;
  if (client.clientSecretHash && client.clientSecretSalt) {
    try {
      return verifySecret(providedSecret, client.clientSecretHash, client.clientSecretSalt);
    } catch {
      return false;
    }
  }
  if (client.clientSecret) {
    const expected = Buffer.from(client.clientSecret);
    const provided = Buffer.from(providedSecret);
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }
  return false;
}
