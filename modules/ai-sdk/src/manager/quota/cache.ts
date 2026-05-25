import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_QUOTA_CACHE_DIR } from "../paths.js";

export interface CacheEntry<T> {
  fetchedAt: number;
  value: T;
}

export function fingerprintKey(parts: string[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(p);
  return h.digest("hex").slice(0, 16);
}

export async function readCache<T>(file: string): Promise<CacheEntry<T> | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

export async function writeCache<T>(file: string, value: T): Promise<CacheEntry<T>> {
  const entry: CacheEntry<T> = { fetchedAt: Math.floor(Date.now() / 1000), value };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(entry), "utf8");
  return entry;
}

export function cacheFile(tool: string, fingerprint: string, dir = DEFAULT_QUOTA_CACHE_DIR): string {
  return join(dir, `quota-${tool}-${fingerprint}.json`);
}

export function isFresh(entry: CacheEntry<unknown> | null, ttlSeconds: number): boolean {
  if (!entry) return false;
  return Math.floor(Date.now() / 1000) - entry.fetchedAt < ttlSeconds;
}
