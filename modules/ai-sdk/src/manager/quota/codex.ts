import { basename, dirname } from "node:path";
import { parseAuthFile } from "../auth-parser.js";
import { DEFAULT_CODEX_AUTH } from "../paths.js";
import type { CodexQuota, QuotaWindow } from "../types.js";
import { CodexAppServerTransport } from "../../transports/codex-app-server-transport.js";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.js";

const DEFAULT_TTL = 60; // seconds
const DEFAULT_TIMEOUT_MS = 15000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
// The old cache was populated from /backend-api/codex/responses headers. Keep
// the new app-server snapshots in a separate namespace so an upgrade cannot
// surface a model-specific response limit as the account's weekly limit.
const CACHE_TOOL = "codex-app-server";

interface CodexRateLimitWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}

interface CodexCreditsSnapshot {
  hasCredits?: unknown;
  balance?: unknown;
  unlimited?: unknown;
}

interface CodexRateLimitSnapshot {
  limitId?: unknown;
  limitName?: unknown;
  planType?: unknown;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: CodexCreditsSnapshot | null;
  rateLimitReachedType?: unknown;
}

interface CodexRateLimitsResponse {
  rateLimits?: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits?: unknown;
}

export interface GetCodexQuotaOptions {
  codexAuthPath?: string;
  /** Cache TTL in seconds. Default 60. Pass 0 to always bypass cache. */
  ttlSeconds?: number;
  /** If true, ignore cache and refetch. */
  forceRefresh?: boolean;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** @deprecated Quota is account-scoped and no longer fetched through a model response. */
  model?: string;
  /** @deprecated The Codex app-server reads its own config from CODEX_HOME. */
  codexConfigPath?: string;
  /** Override cache directory (mainly for tests). */
  cacheDir?: string;
  /** Override the app-server reader (tests only). */
  rateLimitsReader?: (options: {
    codexAuthPath: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function quotaWindow(value: CodexRateLimitWindow | null | undefined): QuotaWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usedPercent = finiteNumber(value.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetAt = finiteNumber(value.resetsAt);
  const now = Math.floor(Date.now() / 1000);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetAt,
    resetAfterSeconds: resetAt === undefined ? undefined : Math.max(0, resetAt - now),
    windowMinutes: finiteNumber(value.windowDurationMins),
  };
}

/** Normalize Codex app-server `account/rateLimits/read` into the manager shape. */
export function parseCodexRateLimitsResponse(
  response: unknown,
  extras: { email?: string; accountId?: string } = {},
): Omit<CodexQuota, "tool" | "fetchedAt" | "source"> {
  const payload = response && typeof response === "object"
    ? response as CodexRateLimitsResponse
    : {};
  // `rateLimits` is the official backward-compatible account bucket. Do not
  // pick a model-specific entry from rateLimitsByLimitId: e.g. Spark can have
  // a different weekly percentage from the main Codex account limit.
  const snapshot = payload.rateLimits && typeof payload.rateLimits === "object"
    ? payload.rateLimits
    : undefined;
  const windows = [quotaWindow(snapshot?.primary), quotaWindow(snapshot?.secondary)];
  const weekly = windows.find(
    (window) => (window?.windowMinutes ?? 0) >= WEEKLY_WINDOW_MINUTES,
  );
  const credits = snapshot?.credits && typeof snapshot.credits === "object"
    ? {
        hasCredits: snapshot.credits.hasCredits === true,
        balance: nonEmptyString(snapshot.credits.balance),
        unlimited: snapshot.credits.unlimited === true,
      }
    : undefined;
  const limitId = nonEmptyString(snapshot?.limitId);
  const limitName = nonEmptyString(snapshot?.limitName);

  return {
    plan: nonEmptyString(snapshot?.planType),
    activeLimit: limitName ?? limitId,
    weekly,
    credits,
    email: extras.email,
    accountId: extras.accountId,
    raw: payload as Record<string, unknown>,
    ...(!weekly ? { error: "Codex rate-limit response has no weekly window" } : {}),
  };
}

export async function getCodexQuota(opts: GetCodexQuotaOptions = {}): Promise<CodexQuota> {
  const codexAuthPath = opts.codexAuthPath ?? DEFAULT_CODEX_AUTH;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const authInfo = await parseAuthFile(codexAuthPath);
  if (!authInfo.accessToken) {
    return emptyQuota("unknown", "codex auth.json missing access_token");
  }

  const fp = fingerprintKey([CACHE_TOOL, authInfo.identityFingerprint ?? "unknown"]);
  const file = cacheFile(CACHE_TOOL, fp, opts.cacheDir);

  if (!opts.forceRefresh && ttl > 0) {
    const cached = await readCache<CodexQuota>(file);
    if (isFresh(cached, ttl) && cached) {
      return { ...cached.value, source: "cached" };
    }
  }

  let response: unknown;
  try {
    response = await (opts.rateLimitsReader ?? readCodexRateLimits)({
      codexAuthPath,
      timeoutMs,
    });
  } catch (error: unknown) {
    return fallbackFromCache(file, ttl, errorMessage(error));
  }

  const parsed = parseCodexRateLimitsResponse(response, {
    email: authInfo.email,
    accountId: authInfo.accountId,
  });
  if (!parsed.weekly) {
    return fallbackFromCache(file, ttl, parsed.error ?? "Codex weekly quota unavailable");
  }

  const fresh: CodexQuota = {
    tool: "codex",
    fetchedAt: Math.floor(Date.now() / 1000),
    source: "fresh",
    ...parsed,
  };
  await writeCache<CodexQuota>(file, fresh);
  return fresh;
}

async function readCodexRateLimits(options: {
  codexAuthPath: string;
  timeoutMs: number;
}): Promise<unknown> {
  if (basename(options.codexAuthPath) !== "auth.json") {
    throw new Error(
      `Codex app-server quota requires an active auth.json path; got ${options.codexAuthPath}`,
    );
  }

  const transport = new CodexAppServerTransport({
    env: { CODEX_HOME: dirname(options.codexAuthPath) },
    ignoreCodexApiKey: true,
  });
  try {
    return await withTimeout(
      transport.request("account/rateLimits/read"),
      options.timeoutMs,
      "Codex account/rateLimits/read timed out",
    );
  } finally {
    await transport.close();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fallbackFromCache(
  file: string,
  ttl: number,
  error: string,
): Promise<CodexQuota> {
  const cached = await readCache<CodexQuota>(file);
  if (cached) {
    return {
      ...cached.value,
      source: isFresh(cached, ttl) ? "cached" : "stale",
      error,
    };
  }
  return emptyQuota("unknown", error);
}

/**
 * Read the on-disk quota cache for a given codex auth.json without triggering
 * any network call. Only app-server snapshots are considered; legacy caches
 * from response headers are intentionally ignored.
 */
export async function readCachedCodexQuota(
  codexAuthPath: string,
  opts: { cacheDir?: string } = {},
): Promise<CodexQuota | null> {
  try {
    const authInfo = await parseAuthFile(codexAuthPath);
    if (!authInfo.identityFingerprint) return null;
    const fp = fingerprintKey([CACHE_TOOL, authInfo.identityFingerprint]);
    const file = cacheFile(CACHE_TOOL, fp, opts.cacheDir);
    const entry = await readCache<CodexQuota>(file);
    if (!entry) return null;
    return {
      ...entry.value,
      source: "cached",
      fetchedAt: entry.fetchedAt,
    };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyQuota(source: CodexQuota["source"], error?: string): CodexQuota {
  return {
    tool: "codex",
    source,
    error,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
