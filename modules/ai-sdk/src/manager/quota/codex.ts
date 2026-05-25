import { readFile } from "node:fs/promises";
import { parseAuthFile } from "../auth-parser.js";
import { DEFAULT_CODEX_AUTH, DEFAULT_CODEX_CONFIG } from "../paths.js";
import type { CodexQuota, QuotaWindow } from "../types.js";
import { bool, headersToMap, num, str } from "./headers.js";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.js";

/** Best-effort: read the configured model from ~/.codex/config.toml. */
async function readConfiguredModel(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    // Minimal top-level key scan: `model = "..."` (skip lines inside [tables]).
    let inRootTable = true;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed === "") continue;
      if (/^\[/.test(trimmed)) {
        inRootTable = false;
        continue;
      }
      if (!inRootTable) continue;
      const m = /^model\s*=\s*"([^"]+)"/.exec(trimmed);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }
  return undefined;
}

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_TTL = 60; // seconds
const DEFAULT_TIMEOUT_MS = 15000;

export interface GetCodexQuotaOptions {
  codexAuthPath?: string;
  /** Cache TTL in seconds. Default 60. Pass 0 to always bypass cache. */
  ttlSeconds?: number;
  /** If true, ignore cache and refetch. */
  forceRefresh?: boolean;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Model name; defaults to the one in ~/.codex/config.toml, then `gpt-5`. */
  model?: string;
  /** Override path to codex config.toml (to detect model). */
  codexConfigPath?: string;
  /** Override cache directory (mainly for tests). */
  cacheDir?: string;
}

function windowFromHeaders(
  map: Record<string, string>,
  prefix: "x-codex-primary" | "x-codex-secondary",
): QuotaWindow {
  const usedPercent = num(map, `${prefix}-used-percent`) ?? 0;
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetAfterSeconds: num(map, `${prefix}-reset-after-seconds`),
    resetAt: num(map, `${prefix}-reset-at`),
    windowMinutes: num(map, `${prefix}-window-minutes`),
  };
}

function parseCodexHeaders(
  map: Record<string, string>,
  extras: { email?: string; accountId?: string },
): Omit<CodexQuota, "tool" | "fetchedAt" | "source"> {
  return {
    plan: str(map, "x-codex-plan-type"),
    activeLimit: str(map, "x-codex-active-limit"),
    fiveHour: windowFromHeaders(map, "x-codex-primary"),
    weekly: windowFromHeaders(map, "x-codex-secondary"),
    credits: {
      hasCredits: bool(map, "x-codex-credits-has-credits") ?? false,
      balance: str(map, "x-codex-credits-balance"),
      unlimited: bool(map, "x-codex-credits-unlimited") ?? false,
    },
    email: extras.email,
    accountId: extras.accountId,
    raw: Object.fromEntries(Object.entries(map).filter(([k]) => k.startsWith("x-codex-"))),
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

  const fp = fingerprintKey(["codex", authInfo.identityFingerprint ?? "unknown"]);
  const file = cacheFile("codex", fp, opts.cacheDir);

  if (!opts.forceRefresh && ttl > 0) {
    const cached = await readCache<CodexQuota>(file);
    if (isFresh(cached, ttl) && cached) {
      return { ...cached.value, source: "cached" };
    }
  }

  const model =
    opts.model ??
    (await readConfiguredModel(opts.codexConfigPath ?? DEFAULT_CODEX_CONFIG)) ??
    "gpt-5";

  const body = JSON.stringify({
    model,
    instructions: "Reply with exactly one character.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "." }] },
    ],
    stream: true,
    store: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authInfo.accessToken}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "responses=experimental",
        ...(authInfo.accountId ? { "chatgpt-account-id": authInfo.accountId } : {}),
      },
      body,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    return await fallbackFromCache(file, ttl, err?.message ?? String(err));
  }

  // Abort the body stream immediately once headers are in; they're all we need.
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
  clearTimeout(timer);

  const map = headersToMap(res.headers);
  if (res.status === 401 || res.status === 403) {
    return await fallbackFromCache(file, ttl, `auth failed: HTTP ${res.status}`);
  }

  const parsed = parseCodexHeaders(map, {
    email: authInfo.email,
    accountId: authInfo.accountId,
  });
  const now = Math.floor(Date.now() / 1000);
  const fresh: CodexQuota = {
    tool: "codex",
    fetchedAt: now,
    source: "fresh",
    ...parsed,
  };

  // Only persist if we actually got rate-limit headers — otherwise the upstream was unhealthy.
  if (Object.keys(fresh.raw ?? {}).length > 0) {
    await writeCache<CodexQuota>(file, fresh);
    return fresh;
  }
  return await fallbackFromCache(file, ttl, `no x-codex-* headers on HTTP ${res.status}`);
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
 * any network call. Returns whatever snapshot was last written (regardless of
 * age) or `null` if nothing has been cached for this identity yet. Used by the
 * daemon's `list_accounts` handler to surface "last known" quota for inactive
 * accounts so the web UI can restore them across page refreshes.
 */
export async function readCachedCodexQuota(
  codexAuthPath: string,
  opts: { cacheDir?: string } = {},
): Promise<CodexQuota | null> {
  try {
    const authInfo = await parseAuthFile(codexAuthPath);
    if (!authInfo.identityFingerprint) return null;
    const fp = fingerprintKey(["codex", authInfo.identityFingerprint]);
    const file = cacheFile("codex", fp, opts.cacheDir);
    const entry = await readCache<CodexQuota>(file);
    if (!entry) return null;
    return { ...entry.value, source: "cached", fetchedAt: entry.fetchedAt };
  } catch {
    return null;
  }
}

function emptyQuota(source: CodexQuota["source"], error?: string): CodexQuota {
  return {
    tool: "codex",
    source,
    error,
    fetchedAt: Math.floor(Date.now() / 1000),
    fiveHour: { usedPercent: 0, remainingPercent: 0 },
    weekly: { usedPercent: 0, remainingPercent: 0 },
  };
}
