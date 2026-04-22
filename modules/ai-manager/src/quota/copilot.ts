import type { CopilotClientOptions } from "@github/copilot-sdk";
import type { CopilotQuota, CopilotQuotaSnapshot, QuotaWindow } from "../types.ts";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.ts";

const DEFAULT_TTL = 60;
const DEFAULT_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const GITHUB_TOKEN_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

interface AccountGetQuotaResult {
  quotaSnapshots?: Record<string, unknown>;
}

interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop?: () => Promise<void>;
  getAuthStatus?: () => Promise<{
    isAuthenticated: boolean;
    authType?: string;
    host?: string;
    login?: string;
    statusMessage?: string;
  }>;
  rpc: {
    account: {
      getQuota(): Promise<AccountGetQuotaResult>;
    };
  };
}

interface CopilotSdkModule {
  CopilotClient: new (options?: CopilotClientOptions) => CopilotClientLike;
}

interface CopilotAuthIndex {
  cacheKey: string;
}

export interface GetCopilotQuotaOptions {
  /** Cache TTL in seconds. Default 60. */
  ttlSeconds?: number;
  forceRefresh?: boolean;
  /** Overall timeout for SDK start/auth/quota in ms. Cleanup has a separate small cap. */
  timeoutMs?: number;
  cacheDir?: string;
  /** Explicit token to pass to the Copilot SDK; otherwise SDK auth discovery is used. */
  githubToken?: string;
  /** SDK client options. Useful for enterprise hosts or tests. */
  clientOptions?: CopilotClientOptions;
  /** Override SDK module for tests. */
  sdkModule?: CopilotSdkModule;
}

export async function getCopilotQuota(
  opts: GetCopilotQuotaOptions = {},
): Promise<CopilotQuota> {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineStartedAt = Date.now();
  const preStartCacheKey = resolveExplicitAuthCacheKey(opts);
  let file = preStartCacheKey ? cachePathForIdentity(preStartCacheKey, opts.cacheDir) : undefined;
  let canWriteQuotaCache = Boolean(preStartCacheKey);

  if (!file) {
    const rememberedCacheKey = await readRememberedAuthCacheKey(opts.cacheDir);
    if (rememberedCacheKey) {
      file = cachePathForIdentity(rememberedCacheKey, opts.cacheDir);
    }
  }

  if (file && !opts.forceRefresh && ttl > 0) {
    const cached = await readCache<CopilotQuota>(file);
    if (isFresh(cached, ttl) && cached) {
      return { ...cached.value, source: "cached" };
    }
  }

  let client: CopilotClientLike | undefined;
  try {
    const sdk = opts.sdkModule ?? (await import("@github/copilot-sdk"));
    client = new sdk.CopilotClient(resolveClientOptions(opts));
    const startTimeoutMs = remainingTimeoutMs(
      deadlineStartedAt,
      timeoutMs,
      "copilot quota request timed out",
    );
    await withTimeout(client.start(), startTimeoutMs, "copilot SDK start timed out");
    const authTimeoutMs = remainingTimeoutMs(
      deadlineStartedAt,
      timeoutMs,
      "copilot quota request timed out",
    );
    const authStatus = await getClientAuthStatus(
      client,
      authTimeoutMs,
    );
    const authCacheKey = preStartCacheKey ?? authStatusToCacheKey(authStatus);
    file = authCacheKey ? cachePathForIdentity(authCacheKey, opts.cacheDir) : file;
    canWriteQuotaCache = Boolean(authCacheKey);
    if (!preStartCacheKey && authCacheKey) {
      await writeRememberedAuthCacheKey(authCacheKey, opts.cacheDir);
    } else if (!preStartCacheKey && shouldClearRememberedAuthCacheKey(authStatus)) {
      await clearRememberedAuthCacheKey(opts.cacheDir);
      file = undefined;
    }

    if (file && !opts.forceRefresh && ttl > 0) {
      const cached = await readCache<CopilotQuota>(file);
      if (isFresh(cached, ttl) && cached) {
        return { ...cached.value, source: "cached" };
      }
    }

    const quotaTimeoutMs = remainingTimeoutMs(
      deadlineStartedAt,
      timeoutMs,
      "copilot quota request timed out",
    );
    const payload = await withTimeout(
      client.rpc.account.getQuota(),
      quotaTimeoutMs,
      "copilot quota request timed out",
    );
    const parsed = parseCopilotQuotaSnapshots(payload?.quotaSnapshots);
    const fresh: CopilotQuota = {
      tool: "copilot",
      fetchedAt: Math.floor(Date.now() / 1000),
      source: "fresh",
      ...parsed,
    };

    if (Object.keys(fresh.snapshots).length > 0) {
      if (file && canWriteQuotaCache) {
        await writeCache<CopilotQuota>(file, fresh);
      }
      return fresh;
    }
    return await fallbackFromCache(file, ttl, "copilot SDK returned no quota snapshots");
  } catch (err: any) {
    return await fallbackFromCache(file, ttl, err?.message ?? String(err));
  } finally {
    await stopClient(client);
  }
}

/** Exported for tests. */
export function parseCopilotQuotaSnapshots(
  rawSnapshots: unknown,
): Omit<CopilotQuota, "tool" | "fetchedAt" | "source" | "error"> {
  const snapshots: Record<string, CopilotQuotaSnapshot> = {};
  if (rawSnapshots && typeof rawSnapshots === "object") {
    for (const [key, value] of Object.entries(rawSnapshots as Record<string, unknown>)) {
      const snapshot = normalizeSnapshot(value);
      if (snapshot) snapshots[key] = snapshot;
    }
  }

  const windows = Object.fromEntries(
    Object.entries(snapshots).map(([key, snapshot]) => [key, windowFromSnapshot(snapshot)]),
  ) as Record<string, QuotaWindow>;

  return {
    snapshots,
    primary:
      windows.premium_interactions ??
      windows.chat ??
      windows.completions ??
      Object.values(windows)[0],
    chat: windows.chat,
    completions: windows.completions,
    premiumInteractions: windows.premium_interactions,
    raw: rawSnapshots && typeof rawSnapshots === "object"
      ? (rawSnapshots as Record<string, unknown>)
      : undefined,
  };
}

function normalizeSnapshot(value: unknown): CopilotQuotaSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const entitlementRequests = toNumber(obj.entitlementRequests);
  const usedRequests = toNumber(obj.usedRequests);
  const remainingPercentage = toNumber(obj.remainingPercentage);
  if (
    entitlementRequests === undefined ||
    usedRequests === undefined ||
    remainingPercentage === undefined
  ) {
    return undefined;
  }

  return {
    entitlementRequests,
    usedRequests,
    remainingPercentage,
    overage: toNumber(obj.overage) ?? 0,
    overageAllowedWithExhaustedQuota:
      typeof obj.overageAllowedWithExhaustedQuota === "boolean"
        ? obj.overageAllowedWithExhaustedQuota
        : false,
    resetDate: typeof obj.resetDate === "string" ? obj.resetDate : undefined,
    isUnlimitedEntitlement:
      typeof obj.isUnlimitedEntitlement === "boolean"
        ? obj.isUnlimitedEntitlement
        : entitlementRequests === -1,
    usageAllowedWithExhaustedQuota:
      typeof obj.usageAllowedWithExhaustedQuota === "boolean"
        ? obj.usageAllowedWithExhaustedQuota
        : undefined,
  };
}

function windowFromSnapshot(snapshot: CopilotQuotaSnapshot): QuotaWindow {
  const remainingPercent = normalizePercent(snapshot.remainingPercentage);
  const usedPercent = round1(Math.max(0, Math.min(100, 100 - remainingPercent)));
  const unlimited = snapshot.isUnlimitedEntitlement === true || snapshot.entitlementRequests === -1;
  const limit = unlimited ? undefined : snapshot.entitlementRequests;
  const used = Math.max(0, snapshot.usedRequests);
  const remaining =
    limit !== undefined ? Math.max(0, limit - used) : undefined;

  return {
    usedPercent,
    remainingPercent,
    resetAt: parseResetDate(snapshot.resetDate),
    status: unlimited
      ? "unlimited"
      : remainingPercent <= 0
        ? "exhausted"
        : snapshot.overageAllowedWithExhaustedQuota
          ? "overage_allowed"
          : "allowed",
    limit,
    used,
    remaining,
  };
}

function parseResetDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return Math.floor(t / 1000);
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return round1(Math.max(0, Math.min(100, percent)));
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function remainingTimeoutMs(startedAtMs: number, timeoutMs: number, message: string): number {
  const remaining = timeoutMs - (Date.now() - startedAtMs);
  if (remaining <= 0) {
    throw new Error(message);
  }
  return remaining;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function resolveExplicitAuthCacheKey(opts: GetCopilotQuotaOptions): string | undefined {
  const token =
    opts.githubToken ??
    opts.clientOptions?.githubToken;
  return token ? `token:${token}` : undefined;
}

function resolveClientOptions(opts: GetCopilotQuotaOptions): CopilotClientOptions {
  const explicitGithubToken = opts.githubToken ?? opts.clientOptions?.githubToken;
  const baseEnv = opts.clientOptions?.env ?? process.env;
  return {
    logLevel: "none",
    ...opts.clientOptions,
    env: explicitGithubToken ? baseEnv : withoutGitHubTokenEnv(baseEnv),
    useLoggedInUser:
      explicitGithubToken
        ? opts.clientOptions?.useLoggedInUser
        : opts.clientOptions?.useLoggedInUser ?? true,
    ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
  };
}

function withoutGitHubTokenEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const next = { ...env };
  for (const key of GITHUB_TOKEN_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

function authStatusToCacheKey(
  status:
    | {
        isAuthenticated: boolean;
        authType?: string;
        host?: string;
        login?: string;
        statusMessage?: string;
      }
    | null,
): string | undefined {
  if (!status?.isAuthenticated) return undefined;
  const host = status.host || process.env.GH_HOST || "github.com";
  const authType = status.authType || "unknown";
  const login = typeof status.login === "string" ? status.login.trim() : "";
  if (!login) return undefined;
  return `auth:${host}:${authType}:${login}`;
}

function shouldClearRememberedAuthCacheKey(
  status:
    | {
        isAuthenticated: boolean;
        login?: string;
      }
    | null,
): boolean {
  if (!status) return false;
  if (!status.isAuthenticated) return true;
  return !(typeof status.login === "string" && status.login.trim());
}

function cachePathForIdentity(identity: string, dir?: string): string {
  return cacheFile("copilot", fingerprintKey(["copilot", identity]), dir);
}

function authIndexPath(dir?: string): string {
  return cacheFile("copilot", "local-auth", dir);
}

async function readRememberedAuthCacheKey(dir?: string): Promise<string | undefined> {
  const cached = await readCache<CopilotAuthIndex>(authIndexPath(dir));
  const cacheKey = cached?.value?.cacheKey;
  return typeof cacheKey === "string" && cacheKey.startsWith("auth:") ? cacheKey : undefined;
}

async function writeRememberedAuthCacheKey(cacheKey: string, dir?: string): Promise<void> {
  if (!cacheKey.startsWith("auth:")) return;
  await writeCache<CopilotAuthIndex>(authIndexPath(dir), { cacheKey });
}

async function clearRememberedAuthCacheKey(dir?: string): Promise<void> {
  await writeCache<CopilotAuthIndex>(authIndexPath(dir), { cacheKey: "" });
}

async function getClientAuthStatus(
  client: CopilotClientLike,
  timeoutMs: number,
): Promise<Awaited<ReturnType<NonNullable<CopilotClientLike["getAuthStatus"]>>> | null> {
  if (typeof client.getAuthStatus !== "function") return null;
  try {
    return await withTimeout(client.getAuthStatus(), timeoutMs, "copilot auth status timed out");
  } catch {
    return null;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopClient(client: CopilotClientLike | undefined): Promise<void> {
  if (!client) return;
  try {
    await withTimeout(client.stop(), STOP_TIMEOUT_MS, "copilot SDK stop timed out");
  } catch {
    try {
      await client.forceStop?.();
    } catch {
      // ignore cleanup errors
    }
  }
}

async function fallbackFromCache(
  file: string | undefined,
  ttl: number,
  error: string,
): Promise<CopilotQuota> {
  if (!file) {
    return emptyQuota("unknown", error);
  }
  const cached = await readCache<CopilotQuota>(file);
  if (cached) {
    return {
      ...cached.value,
      source: isFresh(cached, ttl) ? "cached" : "stale",
      error,
    };
  }
  return emptyQuota("unknown", error);
}

function emptyQuota(source: CopilotQuota["source"], error?: string): CopilotQuota {
  return {
    tool: "copilot",
    source,
    error,
    fetchedAt: Math.floor(Date.now() / 1000),
    snapshots: {},
  };
}
