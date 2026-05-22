import { homedir } from "node:os";
import path from "node:path";

/**
 * All filesystem layout for chat-web is centralised here so the CLI,
 * daemon, doctor, and tests share one view of the world.
 *
 * Override the root via `CHAT_WEB_HOME` (useful in tests / CI).
 */
export function rootDir(): string {
  return process.env.CHAT_WEB_HOME ?? path.join(homedir(), ".chat-web");
}

export function profilesDir(): string {
  return path.join(rootDir(), "profiles");
}

export function profileDir(provider: string): string {
  return path.join(profilesDir(), sanitize(provider));
}

export function logsDir(): string {
  return path.join(rootDir(), "logs");
}

export function configFile(): string {
  return path.join(rootDir(), "config.json");
}

export function selectorCacheFile(): string {
  return path.join(rootDir(), "selector-cache.json");
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, "_");
}
