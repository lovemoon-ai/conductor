import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export const DEFAULT_CONDUCTOR_CONFIG = join(homedir(), ".conductor", "config.yaml");
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
export const DEFAULT_QUOTA_CACHE_DIR = join(homedir(), ".conductor", "cache", "ai-manager");
