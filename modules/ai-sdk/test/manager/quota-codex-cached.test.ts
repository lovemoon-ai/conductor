import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCachedCodexQuota } from "../../src/manager/quota/codex.ts";
import { cacheFile, fingerprintKey, writeCache } from "../../src/manager/quota/cache.ts";
import { parseAuthFile } from "../../src/manager/auth-parser.ts";
import type { CodexQuota } from "../../src/manager/types.ts";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-codex-cached-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeAuth(path: string): void {
  // Minimal auth.json with only access_token — identityFingerprint falls back
  // to the access-token hash, which is all we need to key the cache in tests.
  writeFileSync(
    path,
    JSON.stringify({
      tokens: { access_token: "test-access-token-abcdef1234567890" },
    }),
  );
}

test("readCachedCodexQuota returns the on-disk snapshot marked as cached", async () => {
  await withTmp(async (dir) => {
    const authPath = join(dir, "auth.json");
    const cacheDir = join(dir, "cache");
    writeAuth(authPath);

    const info = await parseAuthFile(authPath);
    assert.ok(info.identityFingerprint, "auth fixture must have an identity fingerprint");

    const file = cacheFile(
      "codex",
      fingerprintKey(["codex", info.identityFingerprint!]),
      cacheDir,
    );
    const stored: CodexQuota = {
      tool: "codex",
      source: "fresh",
      fetchedAt: 1700000000,
      plan: "PLUS",
      email: "alice@example.com",
      accountId: "acc-alice",
      fiveHour: { usedPercent: 42, remainingPercent: 58 },
      weekly: { usedPercent: 10, remainingPercent: 90 },
    };
    await writeCache<CodexQuota>(file, stored);

    const result = await readCachedCodexQuota(authPath, { cacheDir });
    assert.ok(result, "expected a cached entry to be returned");
    // source is always rewritten to 'cached' — the on-disk copy might have
    // been 'fresh' at the time of writing, but from the reader's perspective
    // it's a cached read.
    assert.equal(result!.source, "cached");
    assert.equal(result!.plan, "PLUS");
    assert.equal(result!.email, "alice@example.com");
    assert.equal(result!.fiveHour.usedPercent, 42);
    assert.equal(result!.weekly.remainingPercent, 90);
    // fetchedAt is taken from the cache entry envelope (writeCache stamps it
    // at write time), not from the value's own fetchedAt.
    assert.equal(typeof result!.fetchedAt, "number");
  });
});

test("readCachedCodexQuota returns null when no cache file exists", async () => {
  await withTmp(async (dir) => {
    const authPath = join(dir, "auth.json");
    writeAuth(authPath);
    const result = await readCachedCodexQuota(authPath, {
      cacheDir: join(dir, "cache-that-does-not-exist"),
    });
    assert.equal(result, null);
  });
});

test("readCachedCodexQuota returns null when auth.json is missing", async () => {
  await withTmp(async (dir) => {
    const result = await readCachedCodexQuota(join(dir, "no-such-auth.json"), {
      cacheDir: join(dir, "cache"),
    });
    assert.equal(result, null);
  });
});

test("readCachedCodexQuota returns null when auth.json is malformed", async () => {
  await withTmp(async (dir) => {
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, "not valid json {");
    const result = await readCachedCodexQuota(authPath, {
      cacheDir: join(dir, "cache"),
    });
    assert.equal(result, null);
  });
});

test("readCachedCodexQuota returns null when auth has no identity fingerprint", async () => {
  await withTmp(async (dir) => {
    const authPath = join(dir, "auth.json");
    // No tokens at all → no accessToken, no id_token, no email/accountId →
    // identityFingerprint is undefined → cannot locate cache.
    writeFileSync(authPath, JSON.stringify({ auth_mode: "legacy" }));
    const result = await readCachedCodexQuota(authPath, {
      cacheDir: join(dir, "cache"),
    });
    assert.equal(result, null);
  });
});
