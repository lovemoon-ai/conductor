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

export function resolveDefaultQuotaCacheDir(env: PathEnv = process.env): string {
  return join(resolveConductorHome(env), "cache", "ai-manager");
}

export const DEFAULT_CONDUCTOR_CONFIG = resolveDefaultConductorConfig();
export const DEFAULT_CODEX_AUTH = join(homedir(), ".codex", "auth.json");
export const DEFAULT_CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
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
