import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import type { CopilotQuota, CopilotQuotaSnapshot, QuotaWindow } from "../types.ts";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.ts";

const DEFAULT_TTL = 60;
const DEFAULT_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const SECURITY_TIMEOUT_MS = 5_000;
const GITHUB_TOKEN_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const GITHUB_USER_AGENT = "conductor-ai-manager";
const GITHUB_API_VERSION = "2022-11-28";
const COPILOT_KEYCHAIN_SERVICE = "copilot-cli";
const COPILOT_USER_PATH = "/copilot_internal/user";
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

interface AccountGetQuotaResult {
  quotaSnapshots?: Record<string, unknown>;
}

interface CopilotAuthStatus {
  isAuthenticated: boolean;
  authType?: string;
  host?: string;
  login?: string;
  statusMessage?: string;
}

interface CopilotAuthInfo {
  authType?: string;
  host?: string;
  login?: string;
  loginSource?: "sdk" | "github_token";
}

interface CopilotUserQuotaSnapshot {
  entitlement?: unknown;
  overage_count?: unknown;
  overage_permitted?: unknown;
  percent_remaining?: unknown;
  quota_id?: unknown;
  quota_remaining?: unknown;
  remaining?: unknown;
  unlimited?: unknown;
  timestamp_utc?: unknown;
}

interface CopilotUserResponse {
  login?: unknown;
  access_type_sku?: unknown;
  copilot_plan?: unknown;
  quota_reset_date?: unknown;
  quota_reset_date_utc?: unknown;
  quota_snapshots?: Record<string, unknown>;
  limited_user_quotas?: Record<string, unknown>;
  monthly_quotas?: Record<string, unknown>;
  limited_user_reset_date?: unknown;
}

interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop?: () => Promise<void>;
  getAuthStatus?: () => Promise<CopilotAuthStatus>;
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

interface ResolveBundledCopilotCliPathOptions {
  platform?: NodeJS.Platform | string;
  arch?: string;
  resolvePackage?: (packageName: string) => string;
  resolvePackagePaths?: (packageName: string) => string[] | null;
  existsSyncFn?: (path: string) => boolean;
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
  /** Override global fetch for GitHub login lookup tests. */
  fetcher?: typeof fetch;
  /** Override SDK module for tests. */
  sdkModule?: CopilotSdkModule;
  /** Override stored-token lookup for Copilot logged-in users. */
  storedTokenResolver?: (authInfo: CopilotAuthInfo | undefined) => Promise<string | undefined>;
}

export async function getCopilotQuota(
  opts: GetCopilotQuotaOptions = {},
): Promise<CopilotQuota> {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineStartedAt = Date.now();
  const doFetch: typeof fetch = opts.fetcher ?? fetch;
  const preStartCacheKey = resolveExplicitAuthCacheKey(opts);
  let file = preStartCacheKey ? cachePathForIdentity(preStartCacheKey, opts.cacheDir) : undefined;
  let canWriteQuotaCache = Boolean(preStartCacheKey);
  let authInfo: CopilotAuthInfo | undefined;

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
    authInfo = await resolveCopilotAuthInfo(
      authStatus,
      opts,
      doFetch,
      safeRemainingTimeoutMs(deadlineStartedAt, timeoutMs),
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
        return applyAuthInfo({ ...cached.value, source: "cached" }, authInfo);
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
    let parsed = parseCopilotQuotaSnapshots(payload?.quotaSnapshots);
    const userPayload =
      Object.keys(parsed.snapshots).length > 0
        ? undefined
        : await fetchCopilotUserQuota(
          authInfo,
          opts,
          doFetch,
          safeRemainingTimeoutMs(deadlineStartedAt, timeoutMs),
        );
    if (userPayload) {
      parsed = parseCopilotUserQuota(userPayload);
    }
    const fresh = applyAuthInfo({
      tool: "copilot",
      fetchedAt: Math.floor(Date.now() / 1000),
      source: "fresh",
      ...parsed,
    }, authInfo);

    if (Object.keys(fresh.snapshots).length > 0) {
      if (file && canWriteQuotaCache) {
        await writeCache<CopilotQuota>(file, fresh);
      }
      return fresh;
    }
    return await fallbackFromCache(
      file,
      ttl,
      userPayload ? "copilot account did not expose quota data" : "copilot SDK returned no quota snapshots",
      authInfo,
    );
  } catch (err: any) {
    authInfo ??= await resolveCopilotAuthInfo(
      null,
      opts,
      doFetch,
      safeRemainingTimeoutMs(deadlineStartedAt, timeoutMs),
    );
    return await fallbackFromCache(file, ttl, err?.message ?? String(err), authInfo);
  } finally {
    await stopClient(client);
  }
}

function resolveCopilotPlatformPackageName(
  platform: NodeJS.Platform | string = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    return undefined;
  }
  if (!["arm64", "x64"].includes(arch)) {
    return undefined;
  }
  return `@github/copilot-${platform}-${arch}`;
}

function resolvePackageFileFromSearchPaths(
  packageName: string,
  relativePath: string,
  resolvePackagePaths: (packageName: string) => string[] | null,
  existsSyncFn: (path: string) => boolean,
): string | undefined {
  const searchPaths = resolvePackagePaths(packageName) ?? [];
  const packageParts = packageName.split("/");
  for (const basePath of searchPaths) {
    const candidate = join(basePath, ...packageParts, relativePath);
    if (existsSyncFn(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function resolveBundledCopilotCliPath({
  platform = process.platform,
  arch = process.arch,
  resolvePackage = (packageName: string) => require.resolve(packageName),
  resolvePackagePaths = (packageName: string) => require.resolve.paths(packageName) ?? [],
  existsSyncFn = existsSync,
}: ResolveBundledCopilotCliPathOptions = {}): string | undefined {
  const platformPackageName = resolveCopilotPlatformPackageName(platform, arch);
  if (platformPackageName) {
    try {
      const platformExecutablePath = resolvePackage(platformPackageName);
      if (platformExecutablePath && existsSyncFn(platformExecutablePath)) {
        return platformExecutablePath;
      }
    } catch {
      // Optional platform packages may be absent when optional dependencies are disabled.
    }
  }

  return resolvePackageFileFromSearchPaths(
    "@github/copilot",
    "npm-loader.js",
    resolvePackagePaths,
    existsSyncFn,
  );
}

/** Exported for tests. */
export function parseCopilotQuotaSnapshots(
  rawSnapshots: unknown,
): Omit<
  CopilotQuota,
  "tool" | "fetchedAt" | "source" | "error" | "login" | "authType" | "host" | "loginSource"
> {
  const snapshots: Record<string, CopilotQuotaSnapshot> = {};
  if (rawSnapshots && typeof rawSnapshots === "object") {
    for (const [key, value] of Object.entries(rawSnapshots as Record<string, unknown>)) {
      const snapshot = normalizeSnapshot(value);
      if (snapshot) snapshots[key] = snapshot;
    }
  }

  return buildQuotaFromSnapshots(
    snapshots,
    rawSnapshots && typeof rawSnapshots === "object"
      ? (rawSnapshots as Record<string, unknown>)
      : undefined,
  );
}

/** Exported for tests. */
export function parseCopilotUserQuota(
  rawUser: unknown,
): Omit<
  CopilotQuota,
  "tool" | "fetchedAt" | "source" | "error" | "login" | "authType" | "host" | "loginSource"
> {
  const payload = rawUser && typeof rawUser === "object"
    ? rawUser as CopilotUserResponse
    : undefined;
  const snapshots: Record<string, CopilotQuotaSnapshot> = {};
  const resetDate = resolveCopilotUserResetDate(payload);

  const directSnapshots = payload?.quota_snapshots;
  if (directSnapshots && typeof directSnapshots === "object") {
    for (const [key, value] of Object.entries(directSnapshots)) {
      const snapshot = normalizeUserSnapshot(value, resetDate);
      if (snapshot) snapshots[key] = snapshot;
    }
  }

  if (Object.keys(snapshots).length === 0) {
    const monthly = payload?.monthly_quotas;
    const remaining = payload?.limited_user_quotas;
    if (monthly && typeof monthly === "object" && remaining && typeof remaining === "object") {
      const keys = new Set([...Object.keys(monthly), ...Object.keys(remaining)]);
      for (const key of keys) {
        const snapshot = snapshotFromMonthlyQuota(
          (monthly as Record<string, unknown>)[key],
          (remaining as Record<string, unknown>)[key],
          resetDate,
        );
        if (snapshot) snapshots[key] = snapshot;
      }
    }
  }

  return buildQuotaFromSnapshots(
    snapshots,
    payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined,
  );
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

function normalizeUserSnapshot(
  value: unknown,
  resetDate: string | undefined,
): CopilotQuotaSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as CopilotUserQuotaSnapshot;
  const unlimited = typeof obj.unlimited === "boolean" ? obj.unlimited : false;
  const entitlement = toNumber(obj.entitlement);
  const remaining = toNumber(obj.remaining) ?? toNumber(obj.quota_remaining);
  const explicitPercent = toNumber(obj.percent_remaining);
  const remainingPercentage =
    explicitPercent ??
    (
      entitlement !== undefined &&
        entitlement > 0 &&
        remaining !== undefined
        ? round1((Math.max(0, Math.min(entitlement, remaining)) / entitlement) * 100)
        : unlimited
        ? 100
        : undefined
    );

  let entitlementRequests: number | undefined;
  let usedRequests: number | undefined;

  if (unlimited) {
    entitlementRequests = -1;
    usedRequests = Math.max(0, toNumber(obj.overage_count) ?? 0);
  } else if (entitlement !== undefined) {
    entitlementRequests = entitlement;
    if (remaining !== undefined) {
      usedRequests = Math.max(0, entitlement - Math.max(0, Math.min(entitlement, remaining)));
    } else if (remainingPercentage !== undefined) {
      usedRequests = Math.max(
        0,
        entitlement - Math.round((entitlement * normalizePercent(remainingPercentage)) / 100),
      );
    }
  }

  if (
    remainingPercentage === undefined ||
    entitlementRequests === undefined ||
    usedRequests === undefined
  ) {
    return undefined;
  }

  return {
    entitlementRequests,
    usedRequests,
    remainingPercentage,
    overage: Math.max(0, toNumber(obj.overage_count) ?? 0),
    overageAllowedWithExhaustedQuota:
      typeof obj.overage_permitted === "boolean" ? obj.overage_permitted : false,
    resetDate,
    isUnlimitedEntitlement: unlimited,
  };
}

function snapshotFromMonthlyQuota(
  limitValue: unknown,
  remainingValue: unknown,
  resetDate: string | undefined,
): CopilotQuotaSnapshot | undefined {
  const entitlementRequests = toNumber(limitValue);
  const remaining = toNumber(remainingValue);
  if (
    entitlementRequests === undefined ||
    remaining === undefined ||
    entitlementRequests < 0 ||
    remaining < 0
  ) {
    return undefined;
  }

  const clampedRemaining = Math.max(0, Math.min(entitlementRequests, remaining));
  return {
    entitlementRequests,
    usedRequests: Math.max(0, entitlementRequests - clampedRemaining),
    remainingPercentage:
      entitlementRequests === 0 ? 0 : round1((clampedRemaining / entitlementRequests) * 100),
    overage: 0,
    overageAllowedWithExhaustedQuota: false,
    resetDate,
  };
}

function resolveCopilotUserResetDate(payload: CopilotUserResponse | undefined): string | undefined {
  if (!payload) return undefined;
  return firstString(
    payload.quota_reset_date_utc,
    payload.quota_reset_date,
    payload.limited_user_reset_date,
  );
}

function buildQuotaFromSnapshots(
  snapshots: Record<string, CopilotQuotaSnapshot>,
  raw?: Record<string, unknown>,
): Omit<
  CopilotQuota,
  "tool" | "fetchedAt" | "source" | "error" | "login" | "authType" | "host" | "loginSource"
> {
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
    raw,
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
  const reset = parseResetDate(snapshot.resetDate);

  return {
    usedPercent,
    remainingPercent,
    ...reset,
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

function parseResetDate(
  value: string | undefined,
): Pick<QuotaWindow, "resetAt" | "resetOnDate"> {
  if (!value) return {};
  const dateOnly = normalizeDateOnlyReset(value);
  if (dateOnly) {
    return { resetOnDate: dateOnly };
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) return {};
  return { resetAt: Math.floor(t / 1000) };
}

function normalizeDateOnlyReset(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
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
  const token = resolveExplicitGithubToken(opts);
  return token ? `token:${token}` : undefined;
}

function resolveClientOptions(opts: GetCopilotQuotaOptions): CopilotClientOptions {
  const explicitGithubToken = resolveExplicitGithubToken(opts);
  const baseEnv = opts.clientOptions?.env ?? process.env;
  const options: CopilotClientOptions = {
    logLevel: "none",
    ...opts.clientOptions,
    env: explicitGithubToken ? baseEnv : withoutGitHubTokenEnv(baseEnv),
    useLoggedInUser:
      explicitGithubToken
        ? opts.clientOptions?.useLoggedInUser
        : opts.clientOptions?.useLoggedInUser ?? true,
    ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
  };
  if (
    options.cliPath === undefined &&
    options.cliUrl === undefined &&
    !hasExplicitCopilotCliPathEnv(options.env)
  ) {
    const bundledCliPath = resolveBundledCopilotCliPath();
    if (bundledCliPath) {
      options.cliPath = bundledCliPath;
    }
  }
  return options;
}

function resolveExplicitGithubToken(opts: GetCopilotQuotaOptions): string | undefined {
  return opts.githubToken ?? opts.clientOptions?.githubToken;
}

function hasExplicitCopilotCliPathEnv(env: Record<string, string | undefined> | undefined): boolean {
  return Boolean(typeof env?.COPILOT_CLI_PATH === "string" && env.COPILOT_CLI_PATH.trim());
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
  status: CopilotAuthStatus | null,
): string | undefined {
  if (!status?.isAuthenticated) return undefined;
  const host = resolveKnownGitHubHost(status.host) ?? "github.com";
  const authType = status.authType || "unknown";
  const login = typeof status.login === "string" ? status.login.trim() : "";
  if (!login) return undefined;
  return `auth:${host}:${authType}:${login}`;
}

function shouldClearRememberedAuthCacheKey(
  status: Pick<CopilotAuthStatus, "isAuthenticated" | "login"> | null,
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
): Promise<CopilotAuthStatus | null> {
  if (typeof client.getAuthStatus !== "function") return null;
  try {
    return await withTimeout(client.getAuthStatus(), timeoutMs, "copilot auth status timed out");
  } catch {
    return null;
  }
}

async function resolveCopilotAuthInfo(
  status: CopilotAuthStatus | null,
  opts: GetCopilotQuotaOptions,
  doFetch: typeof fetch,
  timeoutMs?: number,
): Promise<CopilotAuthInfo | undefined> {
  const token = resolveGitHubLoginToken(opts)?.trim();
  const host = resolveKnownGitHubHost(status?.host) ?? (token ? "github.com" : undefined);
  const authType = status?.authType;
  const login = typeof status?.login === "string" ? status.login.trim() : "";
  if (login) {
    return {
      authType,
      host,
      login,
      loginSource: "sdk",
    };
  }

  const fallbackLogin = await lookupGitHubTokenLogin(token, host, doFetch, timeoutMs);
  if (!fallbackLogin) {
    return authType || host ? { authType, host } : undefined;
  }

  return {
    authType: authType ?? "token",
    host,
    login: fallbackLogin,
    loginSource: "github_token",
  };
}

function resolveKnownGitHubHost(rawHost?: string): string | undefined {
  const host = typeof rawHost === "string" ? rawHost.trim() : "";
  const envHost = typeof process.env.GH_HOST === "string" ? process.env.GH_HOST.trim() : "";
  return host || envHost || undefined;
}

function resolveGitHubLoginToken(opts: GetCopilotQuotaOptions): string | undefined {
  return opts.githubToken ?? opts.clientOptions?.githubToken ?? process.env.GITHUB_TOKEN;
}

async function fetchCopilotUserQuota(
  authInfo: CopilotAuthInfo | undefined,
  opts: GetCopilotQuotaOptions,
  doFetch: typeof fetch,
  timeoutMs?: number,
): Promise<Record<string, unknown> | undefined> {
  if (!timeoutMs || timeoutMs <= 0) return undefined;

  const token = await resolveCopilotQuotaFetchToken(authInfo, opts);
  if (!token) return undefined;

  const host = normalizeCopilotAuthHost(authInfo?.host) ?? "https://github.com";
  const apiOrigin = toCopilotApiOrigin(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(new URL(COPILOT_USER_PATH, apiOrigin), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": GITHUB_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json().catch(() => null);
    return payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCopilotQuotaFetchToken(
  authInfo: CopilotAuthInfo | undefined,
  opts: GetCopilotQuotaOptions,
): Promise<string | undefined> {
  const explicitToken = resolveExplicitGithubToken(opts)?.trim();
  if (explicitToken) return explicitToken;
  if (!authInfo?.login || authInfo.loginSource === "github_token") return undefined;
  return await resolveStoredCopilotToken(authInfo, opts);
}

async function resolveStoredCopilotToken(
  authInfo: CopilotAuthInfo,
  opts: GetCopilotQuotaOptions,
): Promise<string | undefined> {
  if (opts.storedTokenResolver) {
    return trimToUndefined(await opts.storedTokenResolver(authInfo));
  }

  const host = normalizeCopilotAuthHost(authInfo.host) ?? "https://github.com";
  const login = trimToUndefined(authInfo.login);
  if (!login) return undefined;

  const env = opts.clientOptions?.env ?? process.env;
  const fromConfig = await readCopilotTokenFromConfig(host, login, env);
  if (fromConfig) return fromConfig;
  if (process.platform !== "darwin") return undefined;

  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-s",
        COPILOT_KEYCHAIN_SERVICE,
        "-a",
        `${host}:${login}`,
        "-w",
      ],
      {
        encoding: "utf8",
        timeout: SECURITY_TIMEOUT_MS,
      },
    );
    return trimToUndefined(stdout);
  } catch {
    return undefined;
  }
}

async function readCopilotTokenFromConfig(
  host: string,
  login: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const configPath = resolveCopilotConfigPath(env);
  if (!configPath) return undefined;
  try {
    const payload = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const rawTokens =
      payload.copilot_tokens ??
      payload.copilotTokens;
    if (!rawTokens || typeof rawTokens !== "object") return undefined;

    const tokenMap = rawTokens as Record<string, unknown>;
    for (const key of tokenLookupKeys(host, login)) {
      const token = trimToUndefined(tokenMap[key]);
      if (token) return token;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveCopilotConfigPath(env: Record<string, string | undefined>): string | undefined {
  const configDir = trimToUndefined(env.COPILOT_CONFIG_DIR);
  if (configDir) return join(configDir, "config.json");
  const home = trimToUndefined(env.HOME) ?? trimToUndefined(env.USERPROFILE);
  return home ? join(home, ".copilot", "config.json") : undefined;
}

function tokenLookupKeys(host: string, login: string): string[] {
  const withoutProtocol = host.replace(/^https?:\/\//, "");
  return [`${host}:${login}`, `${withoutProtocol}:${login}`];
}

function normalizeCopilotAuthHost(rawHost?: string): string | undefined {
  const host = trimToUndefined(rawHost);
  if (!host) return undefined;
  try {
    return new URL(host.startsWith("http://") || host.startsWith("https://") ? host : `https://${host}`)
      .origin;
  } catch {
    return undefined;
  }
}

function toCopilotApiOrigin(host: string): string {
  const url = new URL(host);
  if (!url.hostname.startsWith("api.")) {
    url.hostname = `api.${url.hostname}`;
  }
  return url.origin;
}

async function lookupGitHubTokenLogin(
  token: string | undefined,
  host: string | undefined,
  doFetch: typeof fetch,
  timeoutMs?: number,
): Promise<string | undefined> {
  if (!token || !timeoutMs || timeoutMs <= 0) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(githubUserUrl(host ?? "github.com"), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": GITHUB_USER_AGENT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json().catch(() => null) as { login?: unknown } | null;
    const login = typeof payload?.login === "string" ? payload.login.trim() : "";
    return login || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function githubUserUrl(host: string): string {
  return host === "github.com"
    ? "https://api.github.com/user"
    : `https://${host}/api/v3/user`;
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const trimmed = trimToUndefined(value);
    if (trimmed) return trimmed;
  }
  return undefined;
}

function safeRemainingTimeoutMs(startedAtMs: number, timeoutMs: number): number | undefined {
  const remaining = timeoutMs - (Date.now() - startedAtMs);
  return remaining > 0 ? remaining : undefined;
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
  authInfo?: CopilotAuthInfo,
): Promise<CopilotQuota> {
  if (!file) {
    return applyAuthInfo(emptyQuota("unknown", error), authInfo);
  }
  const cached = await readCache<CopilotQuota>(file);
  if (cached) {
    return applyAuthInfo({
      ...cached.value,
      source: isFresh(cached, ttl) ? "cached" : "stale",
      error,
    }, authInfo);
  }
  return applyAuthInfo(emptyQuota("unknown", error), authInfo);
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

function applyAuthInfo(quota: CopilotQuota, authInfo?: CopilotAuthInfo): CopilotQuota {
  if (!authInfo) return quota;
  return {
    ...quota,
    ...(authInfo.authType ? { authType: authInfo.authType } : {}),
    ...(authInfo.host ? { host: authInfo.host } : {}),
    ...(authInfo.login ? { login: authInfo.login } : {}),
    ...(authInfo.loginSource ? { loginSource: authInfo.loginSource } : {}),
  };
}
