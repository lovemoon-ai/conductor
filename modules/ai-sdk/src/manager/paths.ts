import { homedir } from "node:os";
import { join, resolve } from "node:path";

type PathEnv = Record<string, string | undefined>;

function optionalString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function userHome(env: PathEnv = process.env): string {
  return optionalString(env.HOME) || optionalString(env.USERPROFILE) || homedir();
}

function expandHomeWithEnv(p: string, env: PathEnv = process.env): string {
  if (!p) return p;
  const home = userHome(env);
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

export function expandHome(p: string): string {
  return expandHomeWithEnv(p);
}

export function resolveConductorHome(env: PathEnv = process.env): string {
  const configured = optionalString(env.CONDUCTOR_HOME);
  if (configured) {
    const expanded = expandHomeWithEnv(configured, env);
    return resolve(expanded);
  }
  return join(resolve(userHome(env)), ".conductor");
}

export function resolveDefaultConductorConfig(env: PathEnv = process.env): string {
  const configured = optionalString(env.CONDUCTOR_CONFIG);
  if (configured) {
    return resolve(expandHomeWithEnv(configured, env));
  }
  return join(resolveConductorHome(env), "config.yaml");
}

/**
 * Claude Code keeps its config (credentials, projects/, tasks/) under
 * $CLAUDE_CONFIG_DIR when that is set - shared hosts point it at network
 * storage - and under ~/.claude otherwise. Returns both, in priority order, so
 * callers can search the override first and still find pre-existing state that
 * was written before the variable was introduced.
 */
export function resolveClaudeConfigDirs(env: PathEnv = process.env, homeDir?: string): string[] {
  const fallback = join(homeDir ? resolve(homeDir) : resolve(userHome(env)), ".claude");
  // An explicit homeDir is a caller/test override that pins the lookup.
  const configured = homeDir ? "" : optionalString(env.CLAUDE_CONFIG_DIR);
  if (!configured) return [fallback];
  const expanded = resolve(expandHomeWithEnv(configured, env));
  return expanded === fallback ? [fallback] : [expanded, fallback];
}

/**
 * Codex keeps auth.json/config.toml under $CODEX_HOME when that is set
 * (identity isolation, multi-instance daemons) and under ~/.codex otherwise.
 */
export function resolveCodexHome(env: PathEnv = process.env): string {
  const configured = optionalString(env.CODEX_HOME);
  if (configured) return resolve(expandHomeWithEnv(configured, env));
  return join(resolve(userHome(env)), ".codex");
}

export function resolveDefaultQuotaCacheDir(env: PathEnv = process.env): string {
  return join(resolveConductorHome(env), "cache", "ai-manager");
}

export const DEFAULT_CONDUCTOR_CONFIG = resolveDefaultConductorConfig();
export const DEFAULT_CODEX_AUTH = join(resolveCodexHome(), "auth.json");
export const DEFAULT_CODEX_CONFIG = join(resolveCodexHome(), "config.toml");
export const DEFAULT_KIMI_CODE_HOME =
  process.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code");
export const DEFAULT_KIMI_CREDENTIAL = join(
  DEFAULT_KIMI_CODE_HOME,
  "credentials",
  "kimi-code.json",
);
export const LEGACY_KIMI_CREDENTIAL = join(
  homedir(),
  ".kimi",
  "credentials",
  "kimi-code.json",
);
export const DEFAULT_QUOTA_CACHE_DIR = resolveDefaultQuotaCacheDir();
