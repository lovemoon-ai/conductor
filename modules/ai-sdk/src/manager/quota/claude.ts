import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeQuota, QuotaWindow } from "../types.js";
import { headersToMap, num, str } from "./headers.js";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.js";
import { resolveClaudeConfigDirs } from "../paths.js";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_TTL = 60;
const DEFAULT_TIMEOUT_MS = 20000;
const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export interface ClaudeCredential {
  kind: "api-key" | "oauth";
  token: string;
  /** JSON source string (for fingerprinting). */
  fingerprintInput: string;
  /** OAuth expiry in epoch ms, when the source reports one. */
  expiresAt?: number;
}

export interface ResolveClaudeCredentialOptions {
  env?: Record<string, string | undefined>;
  /** Pins the lookup to one home, ignoring CLAUDE_CONFIG_DIR (tests). */
  homeDir?: string;
  platform?: string;
  readKeychain?: () => Promise<string | null>;
}

export interface GetClaudeQuotaOptions {
  /** Cache TTL in seconds. Default 60. */
  ttlSeconds?: number;
  forceRefresh?: boolean;
  timeoutMs?: number;
  model?: string;
  cacheDir?: string;
  /** Override credential resolution (mainly for tests). */
  credential?: ClaudeCredential;
}

export async function resolveClaudeCredential(
  opts: ResolveClaudeCredentialOptions = {},
): Promise<ClaudeCredential | null> {
  const env = opts.env ?? process.env;
  const envKey = env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length > 10) {
    return { kind: "api-key", token: envKey, fingerprintInput: envKey };
  }

  // Candidates in priority order:
  //   $CLAUDE_CONFIG_DIR  - explicitly chosen, so it outranks the machine-wide
  //                         Keychain, which belongs to a different account.
  //   Keychain (macOS)    - where Claude Code refreshes tokens to.
  //   ~/.claude           - last, because on macOS it is the stale-file trap:
  //                         refreshes go to the Keychain, so a leftover file
  //                         here holds a dead token.
  const dirs = resolveClaudeConfigDirs(env, opts.homeDir);
  const overrideDir = dirs.length > 1 ? dirs[0] : undefined;
  const homeDir = dirs[dirs.length - 1];
  const readFileCred = (dir: string) => () => oauthFromFile(join(dir, ".credentials.json"));

  const sources: Array<() => Promise<ClaudeCredential | null>> = [];
  if (overrideDir) sources.push(readFileCred(overrideDir));
  if ((opts.platform ?? process.platform) === "darwin") {
    const readKeychain = opts.readKeychain ?? readMacKeychain;
    sources.push(async () => {
      const raw = await readKeychain();
      return raw ? oauthFromJson(raw) : null;
    });
  }
  sources.push(readFileCred(homeDir));

  // Prefer the first live credential. An expired one is remembered but not
  // returned yet, so a stale file cannot shadow a working Keychain entry.
  let expired: ClaudeCredential | null = null;
  for (const read of sources) {
    const cred = await read();
    if (!cred) continue;
    if (!cred.expiresAt || cred.expiresAt > Date.now()) return cred;
    expired ??= cred;
  }
  // Everything on offer is expired: return it anyway so the caller surfaces an
  // auth error rather than a misleading "no credential found".
  return expired;
}

function oauthFromJson(raw: string): ClaudeCredential | null {
  try {
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth ?? parsed;
    if (oauth?.accessToken) {
      return {
        kind: "oauth",
        token: oauth.accessToken,
        fingerprintInput: oauth.accessToken,
        expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
      };
    }
  } catch {
    // not JSON, or no token in it
  }
  return null;
}

async function oauthFromFile(path: string): Promise<ClaudeCredential | null> {
  try {
    return oauthFromJson(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function readMacKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    const user = process.env.USER ?? "";
    const proc = spawn(
      "security",
      ["find-generic-password", "-a", user, "-s", "Claude Code-credentials", "-w"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

function utilizationToWindow(
  map: Record<string, string>,
  prefix: "anthropic-ratelimit-unified-5h" | "anthropic-ratelimit-unified-7d" | "anthropic-ratelimit-unified-7d_sonnet",
): QuotaWindow | undefined {
  const util = num(map, `${prefix}-utilization`);
  if (util === undefined) return undefined;
  const usedPercent = Math.max(0, Math.min(100, util * 100));
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: num(map, `${prefix}-reset`),
    status: str(map, `${prefix}-status`),
  };
}

function parseClaudeHeaders(map: Record<string, string>): Omit<ClaudeQuota, "tool" | "fetchedAt" | "source"> {
  const fiveHour = utilizationToWindow(map, "anthropic-ratelimit-unified-5h") ?? {
    usedPercent: 0,
    remainingPercent: 0,
  };
  const weekly = utilizationToWindow(map, "anthropic-ratelimit-unified-7d") ?? {
    usedPercent: 0,
    remainingPercent: 0,
  };
  const weeklySonnet = utilizationToWindow(map, "anthropic-ratelimit-unified-7d_sonnet");

  return {
    overallStatus: str(map, "anthropic-ratelimit-unified-status"),
    fiveHour,
    weekly,
    weeklySonnet,
    overage: {
      status: str(map, "anthropic-ratelimit-unified-overage-status"),
      disabledReason: str(map, "anthropic-ratelimit-unified-overage-disabled-reason"),
    },
    raw: Object.fromEntries(
      Object.entries(map).filter(([k]) => k.startsWith("anthropic-ratelimit-")),
    ),
  };
}

export async function getClaudeQuota(opts: GetClaudeQuotaOptions = {}): Promise<ClaudeQuota> {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const credential = opts.credential ?? (await resolveClaudeCredential());
  if (!credential) {
    return emptyQuota(
      "unknown",
      "no Claude credential found (ANTHROPIC_API_KEY env, $CLAUDE_CONFIG_DIR/.credentials.json, macOS Keychain, or ~/.claude/.credentials.json)",
    );
  }

  const fp = fingerprintKey(["claude", credential.kind, credential.fingerprintInput.slice(0, 32)]);
  const file = cacheFile("claude", fp, opts.cacheDir);

  if (!opts.forceRefresh && ttl > 0) {
    const cached = await readCache<ClaudeQuota>(file);
    if (isFresh(cached, ttl) && cached) {
      return { ...cached.value, source: "cached" };
    }
  }

  const isOauth = credential.kind === "oauth";
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (isOauth) {
    headers["authorization"] = `Bearer ${credential.token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
    headers["user-agent"] = "claude-cli/1.0.128 (external, cli)";
    headers["x-app"] = "cli";
  } else {
    headers["x-api-key"] = credential.token;
  }

  const body: any = {
    model: opts.model ?? "claude-sonnet-4-5",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  };
  if (isOauth) {
    body.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    return await fallbackFromCache(file, ttl, err?.message ?? String(err));
  }
  clearTimeout(timer);

  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }

  const map = headersToMap(res.headers);
  if ((res.status === 401 || res.status === 403) && !Object.keys(map).some((k) => k.startsWith("anthropic-ratelimit-"))) {
    return await fallbackFromCache(file, ttl, `auth failed: HTTP ${res.status}`);
  }

  const parsed = parseClaudeHeaders(map);
  const fresh: ClaudeQuota = {
    tool: "claude",
    fetchedAt: Math.floor(Date.now() / 1000),
    source: "fresh",
    ...parsed,
  };
  if (Object.keys(fresh.raw ?? {}).length > 0) {
    await writeCache<ClaudeQuota>(file, fresh);
    return fresh;
  }
  return await fallbackFromCache(file, ttl, `no anthropic-ratelimit-* headers on HTTP ${res.status}`);
}

async function fallbackFromCache(
  file: string,
  ttl: number,
  error: string,
): Promise<ClaudeQuota> {
  const cached = await readCache<ClaudeQuota>(file);
  if (cached) {
    return {
      ...cached.value,
      source: isFresh(cached, ttl) ? "cached" : "stale",
      error,
    };
  }
  return emptyQuota("unknown", error);
}

function emptyQuota(source: ClaudeQuota["source"], error?: string): ClaudeQuota {
  return {
    tool: "claude",
    source,
    error,
    fetchedAt: Math.floor(Date.now() / 1000),
    fiveHour: { usedPercent: 0, remainingPercent: 0 },
    weekly: { usedPercent: 0, remainingPercent: 0 },
  };
}
