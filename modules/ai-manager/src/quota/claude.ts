import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeQuota, QuotaWindow } from "../types.ts";
import { headersToMap, num, str } from "./headers.ts";
import { cacheFile, fingerprintKey, isFresh, readCache, writeCache } from "./cache.ts";

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

export async function resolveClaudeCredential(): Promise<ClaudeCredential | null> {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length > 10) {
    return { kind: "api-key", token: envKey, fingerprintInput: envKey };
  }

  if (process.platform === "darwin") {
    const raw = await readMacKeychain();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const oauth = parsed?.claudeAiOauth ?? parsed;
        if (oauth?.accessToken) {
          return {
            kind: "oauth",
            token: oauth.accessToken,
            fingerprintInput: oauth.accessToken,
          };
        }
      } catch {
        // fall through
      }
    }
  }

  // Linux/Windows fallback: look for ~/.claude/.credentials.json (best-effort).
  try {
    const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth ?? parsed;
    if (oauth?.accessToken) {
      return {
        kind: "oauth",
        token: oauth.accessToken,
        fingerprintInput: oauth.accessToken,
      };
    }
  } catch {
    // ignore
  }
  return null;
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
      "no Claude credential found (ANTHROPIC_API_KEY env, macOS Keychain, or ~/.claude/.credentials.json)",
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
