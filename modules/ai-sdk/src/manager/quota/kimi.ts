import { readFile, writeFile, rename } from "node:fs/promises";
import { DEFAULT_KIMI_CREDENTIAL, LEGACY_KIMI_CREDENTIAL } from "../paths.js";
import type { KimiQuota, QuotaWindow } from "../types.js";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.js";

const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const OAUTH_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_TTL = 60;
const DEFAULT_TIMEOUT_MS = 15_000;
const REFRESH_LEEWAY_SECONDS = 60;

export interface KimiCredential {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
}

export interface GetKimiQuotaOptions {
  credentialPath?: string;
  ttlSeconds?: number;
  forceRefresh?: boolean;
  timeoutMs?: number;
  cacheDir?: string;
  /** Override the global fetch (test-only). */
  fetcher?: typeof fetch;
}

export async function getKimiQuota(opts: GetKimiQuotaOptions = {}): Promise<KimiQuota> {
  const credentialPaths = opts.credentialPath
    ? [opts.credentialPath]
    : [DEFAULT_KIMI_CREDENTIAL, LEGACY_KIMI_CREDENTIAL];
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: typeof fetch = opts.fetcher ?? fetch;

  let credentialPath = credentialPaths[0];
  let cred: KimiCredential | undefined;
  let credentialError = "credential missing access_token";
  for (const candidatePath of credentialPaths) {
    try {
      const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as KimiCredential;
      if (!candidate.access_token) {
        credentialError = "credential missing access_token";
        continue;
      }
      credentialPath = candidatePath;
      cred = candidate;
      break;
    } catch (err: any) {
      credentialError = `credential not readable: ${err?.message ?? err}`;
    }
  }
  if (!cred) {
    return emptyQuota("unknown", `kimi ${credentialError}`);
  }

  const fp = fingerprintKey(["kimi", cred.access_token.slice(-32)]);
  const file = cacheFile("kimi", fp, opts.cacheDir);

  if (!opts.forceRefresh && ttl > 0) {
    const cached = await readCache<KimiQuota>(file);
    if (isFresh(cached, ttl) && cached) {
      return { ...cached.value, source: "cached" };
    }
  }

  // Refresh proactively if access_token is expired or about to.
  const nowSec = Math.floor(Date.now() / 1000);
  if (cred.expires_at && cred.expires_at - nowSec < REFRESH_LEEWAY_SECONDS) {
    try {
      cred = await refreshKimiToken(cred, credentialPath, timeoutMs, doFetch);
    } catch (err: any) {
      return await fallbackFromCache(file, ttl, `kimi token refresh failed: ${err?.message ?? err}`);
    }
  }

  let res = await fetchUsage(cred.access_token, timeoutMs, doFetch);
  if (res.status === 401 || res.status === 403) {
    // Token may have been invalidated mid-flight; try one refresh + retry.
    try {
      cred = await refreshKimiToken(cred, credentialPath, timeoutMs, doFetch);
      res = await fetchUsage(cred.access_token, timeoutMs, doFetch);
    } catch (err: any) {
      return await fallbackFromCache(file, ttl, `kimi auth failed: ${err?.message ?? err}`);
    }
  }

  if (!res.ok) {
    return await fallbackFromCache(file, ttl, `kimi usage HTTP ${res.status}`);
  }

  const fresh = parseUsagePayload(res.payload);
  await writeCache<KimiQuota>(file, fresh);
  return fresh;
}

async function fetchUsage(
  token: string,
  timeoutMs: number,
  doFetch: typeof fetch,
): Promise<{ ok: boolean; status: number; payload: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await doFetch(USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    let payload: any = null;
    try {
      payload = await r.json();
    } catch {
      // ignore body parse errors
    }
    return { ok: r.ok, status: r.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

/** Exported for tests. */
export async function refreshKimiToken(
  cred: KimiCredential,
  credentialPath: string,
  timeoutMs: number,
  doFetch: typeof fetch = fetch,
): Promise<KimiCredential> {
  if (!cred.refresh_token) throw new Error("missing refresh_token");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      client_id: KIMI_CODE_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
    });
    const r = await doFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const data = (await r.json()) as Partial<KimiCredential> & { expires_in?: number };
    const next: KimiCredential = {
      access_token: String(data.access_token ?? ""),
      refresh_token: String(data.refresh_token ?? cred.refresh_token),
      expires_at:
        typeof data.expires_at === "number"
          ? data.expires_at
          : Math.floor(Date.now() / 1000) + (data.expires_in ?? 0),
      scope: data.scope ?? cred.scope,
      token_type: data.token_type ?? cred.token_type,
    };
    if (!next.access_token) throw new Error("refresh response missing access_token");
    await persistCredential(credentialPath, next);
    return next;
  } finally {
    clearTimeout(timer);
  }
}

async function persistCredential(path: string, cred: KimiCredential): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cred), { mode: 0o600 });
  await rename(tmp, path);
}

/** Exported for tests. */
export function parseUsagePayload(payload: any): KimiQuota {
  const user = payload?.user ?? {};
  const usage = payload?.user && payload?.usage ? payload.usage : payload?.usage ?? {};
  const limits: any[] = Array.isArray(payload?.limits) ? payload.limits : [];
  const fiveHourEntry = limits.find((entry) => {
    const w = entry?.window;
    if (!w) return false;
    if (w.timeUnit === "TIME_UNIT_MINUTE" && Number(w.duration) === 300) return true;
    if (w.timeUnit === "TIME_UNIT_HOUR" && Number(w.duration) === 5) return true;
    return false;
  });
  const fiveHourDetail = fiveHourEntry?.detail ?? fiveHourEntry ?? {};

  return {
    tool: "kimi",
    userId: typeof user.userId === "string" ? user.userId : undefined,
    region: typeof user.region === "string" ? user.region : undefined,
    membership:
      typeof user?.membership?.level === "string" ? user.membership.level : undefined,
    fiveHour: windowFromKimi(fiveHourDetail, 300),
    weekly: windowFromKimi(usage, 10080),
    parallelLimit: toInt(payload?.parallel?.limit),
    fetchedAt: Math.floor(Date.now() / 1000),
    source: "fresh",
    raw: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined,
  };
}

function windowFromKimi(entry: any, windowMinutes: number): QuotaWindow {
  const limit = toInt(entry?.limit);
  let used = toInt(entry?.used);
  let remaining = toInt(entry?.remaining);
  if (limit !== undefined) {
    if (used === undefined && remaining !== undefined) used = limit - remaining;
    if (remaining === undefined && used !== undefined) remaining = limit - used;
  }
  const usedPercent = limit && limit > 0 && used !== undefined ? (used / limit) * 100 : 0;
  const remainingPercent =
    limit && limit > 0 && remaining !== undefined
      ? (remaining / limit) * 100
      : Math.max(0, 100 - usedPercent);
  const resetAt = parseResetTime(entry?.resetTime ?? entry?.reset_time ?? entry?.resetAt);

  return {
    usedPercent: round1(usedPercent),
    remainingPercent: round1(remainingPercent),
    resetAt,
    windowMinutes,
    limit,
    used,
    remaining,
  };
}

/** Exported for tests. */
export function parseResetTime(value: any): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // Trim sub-microsecond fraction so Date can parse it (Kimi sends nanoseconds).
  let v = value;
  if (v.endsWith("Z") && v.includes(".")) {
    const [base, frac] = v.slice(0, -1).split(".");
    v = `${base}.${frac.slice(0, 6)}Z`;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.floor(t / 1000);
}

function toInt(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

async function fallbackFromCache(
  file: string,
  ttl: number,
  error: string,
): Promise<KimiQuota> {
  const cached = await readCache<KimiQuota>(file);
  if (cached) {
    return {
      ...cached.value,
      source: isFresh(cached, ttl) ? "cached" : "stale",
      error,
    };
  }
  return emptyQuota("unknown", error);
}

function emptyQuota(source: KimiQuota["source"], error?: string): KimiQuota {
  return {
    tool: "kimi",
    source,
    error,
    fetchedAt: Math.floor(Date.now() / 1000),
    fiveHour: { usedPercent: 0, remainingPercent: 0 },
    weekly: { usedPercent: 0, remainingPercent: 0 },
  };
}
