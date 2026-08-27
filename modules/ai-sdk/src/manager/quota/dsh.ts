import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { DshBalanceInfo, DshQuota } from "../types.js";
import { resolveDefaultConductorConfig } from "../paths.js";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.js";

const DEFAULT_TTL = 60;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const BALANCE_PATH = "/user/balance";

/** Raw `/user/balance` bucket, exactly as DeepSeek returns it (amounts are strings). */
interface DeepSeekBalanceInfo {
  currency?: unknown;
  total_balance?: unknown;
  granted_balance?: unknown;
  topped_up_balance?: unknown;
}

interface DeepSeekBalanceResponse {
  is_available?: unknown;
  balance_infos?: unknown;
}

export interface DshQuotaOptions {
  /**
   * Explicit credential; skips the config/env resolution ladder. An empty
   * string is an explicit "no credential" and does NOT fall back, so a caller
   * can probe the unconfigured path deterministically.
   */
  apiKey?: string;
  /** Endpoint base; a `/v1` suffix is tolerated and stripped. */
  baseURL?: string;
  /** Conductor config file to read `envs.DEEPSEEK_API_KEY` from. */
  configPath?: string;
  /** Cache TTL in seconds (default 60). */
  ttlSeconds?: number;
  /** Bypass the cache and always hit the network. */
  forceRefresh?: boolean;
  timeoutMs?: number;
  cacheDir?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Normalize the DeepSeek base URL for the balance endpoint. The inference
 * base commonly carries a `/v1` suffix (it is an OpenAI-compatible route),
 * but `/user/balance` lives at the host root, so the suffix is stripped.
 */
export function normalizeDshBaseUrl(baseURL: string | undefined): string {
  const raw = typeof baseURL === "string" ? baseURL.trim() : "";
  const base = raw || DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

export function parseDshBalance(payload: DeepSeekBalanceResponse): {
  isAvailable: boolean;
  balances: DshBalanceInfo[];
} {
  const rawList = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const balances = rawList
    .filter((entry): entry is DeepSeekBalanceInfo => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      currency: typeof entry.currency === "string" ? entry.currency : "",
      totalBalance: toNumber(entry.total_balance),
      grantedBalance: toNumber(entry.granted_balance),
      toppedUpBalance: toNumber(entry.topped_up_balance),
    }));
  return { isAvailable: payload?.is_available === true, balances };
}

/**
 * Resolve the DeepSeek credential the way {@link DshSdkSession} does, so the
 * balance shown here belongs to the account that actually serves turns:
 * explicit option, then the conductor config's `envs` section, then the
 * launching environment.
 */
export async function resolveDeepSeekCredential(
  options: Pick<DshQuotaOptions, "apiKey" | "baseURL" | "configPath"> = {},
): Promise<{ apiKey: string; baseURL: string }> {
  // `apiKey: ""` is an explicit refusal, distinct from an absent option.
  const keyProvided = typeof options.apiKey === "string";
  let apiKey = keyProvided ? options.apiKey!.trim() : "";
  let baseURL = typeof options.baseURL === "string" ? options.baseURL.trim() : "";

  if (!keyProvided || !baseURL) {
    const configPath = options.configPath ?? resolveDefaultConductorConfig();
    try {
      const doc = parseYaml(await readFile(configPath, "utf8")) as any;
      const envs = doc?.envs;
      if (envs && typeof envs === "object") {
        if (!keyProvided && typeof envs.DEEPSEEK_API_KEY === "string") {
          apiKey = envs.DEEPSEEK_API_KEY.trim();
        }
        if (!baseURL && typeof envs.DEEPSEEK_BASE_URL === "string") {
          baseURL = envs.DEEPSEEK_BASE_URL.trim();
        }
      }
    } catch {
      // Missing or unreadable config: fall through to the environment.
    }
  }

  if (!keyProvided && !apiKey && typeof process.env.DEEPSEEK_API_KEY === "string") {
    apiKey = process.env.DEEPSEEK_API_KEY.trim();
  }
  if (!baseURL && typeof process.env.DEEPSEEK_BASE_URL === "string") {
    baseURL = process.env.DEEPSEEK_BASE_URL.trim();
  }

  return { apiKey, baseURL: normalizeDshBaseUrl(baseURL) };
}

function emptyQuota(error: string, fetchedAt = Math.floor(Date.now() / 1000)): DshQuota {
  return {
    tool: "dsh",
    isAvailable: false,
    balances: [],
    fetchedAt,
    source: "unknown",
    error,
  };
}

/**
 * Read the DeepSeek account balance. DeepSeek bills per token with no rolling
 * usage window, so this reports prepaid balance instead of a percentage-based
 * {@link QuotaWindow}. A stale cache entry is served when the network call
 * fails, matching the other quota providers.
 */
export async function getDshQuota(options: DshQuotaOptions = {}): Promise<DshQuota> {
  const { apiKey, baseURL } = await resolveDeepSeekCredential(options);
  if (!apiKey) {
    return emptyQuota(
      "DEEPSEEK_API_KEY is not configured; set envs.DEEPSEEK_API_KEY in the conductor config",
    );
  }

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL;
  const file = cacheFile("dsh", fingerprintKey([baseURL, apiKey]), options.cacheDir);
  const cached = await readCache<DshQuota>(file);
  if (!options.forceRefresh && isFresh(cached, ttlSeconds)) {
    return { ...(cached as { value: DshQuota }).value, source: "cached" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseURL}${BALANCE_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`DeepSeek balance request failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as DeepSeekBalanceResponse;
    const { isAvailable, balances } = parseDshBalance(payload);
    // No `raw` field: unlike the window-based providers whose parsing is
    // lossy, `balances`/`isAvailable` already capture the whole balance
    // response, so keeping the raw payload would only bloat the cache and the
    // worker/WebSocket hop to the web client.
    const quota: DshQuota = {
      tool: "dsh",
      isAvailable,
      ...(balances[0] ? { primaryBalance: balances[0] } : {}),
      balances,
      fetchedAt: Math.floor(Date.now() / 1000),
      source: "fresh",
    };
    const entry = await writeCache(file, quota);
    return { ...quota, fetchedAt: entry.fetchedAt };
  } catch (err: any) {
    const message = err?.name === "AbortError" ? "timeout" : err?.message ?? String(err);
    if (cached) {
      return { ...cached.value, source: "stale", error: message };
    }
    return emptyQuota(message);
  } finally {
    clearTimeout(timer);
  }
}

/** Read the last cached balance without touching the network. */
export async function readCachedDshQuota(
  options: Pick<DshQuotaOptions, "apiKey" | "baseURL" | "configPath" | "cacheDir"> = {},
): Promise<DshQuota | null> {
  const { apiKey, baseURL } = await resolveDeepSeekCredential(options);
  if (!apiKey) return null;
  const file = cacheFile("dsh", fingerprintKey([baseURL, apiKey]), options.cacheDir);
  const cached = await readCache<DshQuota>(file);
  if (!cached) return null;
  return { ...cached.value, fetchedAt: cached.fetchedAt, source: "cached" };
}
