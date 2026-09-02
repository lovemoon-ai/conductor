import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveClaudeCredential } from "../../src/manager/quota/claude.ts";

const HOUR = 3600_000;

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-claude-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeCreds(dir: string, accessToken: string, expiresAt?: number): void {
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } }),
  );
}

/** Never touches the real Keychain or the developer's real ~/.claude. */
function isolated(overrides: Record<string, unknown> = {}) {
  return {
    env: {} as Record<string, string | undefined>,
    homeDir: undefined as string | undefined,
    platform: "linux",
    readKeychain: async () => null,
    ...overrides,
  };
}

test("reads $CLAUDE_CONFIG_DIR/.credentials.json", async () => {
  await withTmp(async (dir) => {
    writeCreds(dir, "tok-from-config-dir", Date.now() + HOUR);
    const cred = await resolveClaudeCredential(
      isolated({ env: { CLAUDE_CONFIG_DIR: dir, HOME: "/nonexistent" } }),
    );
    assert.equal(cred?.kind, "oauth");
    assert.equal(cred?.token, "tok-from-config-dir");
  });
});

test("expands ~ in CLAUDE_CONFIG_DIR", async () => {
  await withTmp(async (home) => {
    const dir = join(home, "ai-identities", "a", "claude");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeCreds(dir, "tok-tilde", Date.now() + HOUR);
    const cred = await resolveClaudeCredential(
      isolated({ env: { CLAUDE_CONFIG_DIR: "~/ai-identities/a/claude", HOME: home } }),
    );
    assert.equal(cred?.token, "tok-tilde");
  });
});

test("ANTHROPIC_API_KEY wins over CLAUDE_CONFIG_DIR", async () => {
  await withTmp(async (dir) => {
    writeCreds(dir, "tok-from-config-dir", Date.now() + HOUR);
    const cred = await resolveClaudeCredential(
      isolated({ env: { ANTHROPIC_API_KEY: "sk-ant-api-key-value", CLAUDE_CONFIG_DIR: dir } }),
    );
    assert.equal(cred?.kind, "api-key");
    assert.equal(cred?.token, "sk-ant-api-key-value");
  });
});

test("a live config-dir credential outranks the macOS Keychain", async () => {
  await withTmp(async (dir) => {
    writeCreds(dir, "tok-config-dir", Date.now() + HOUR);
    let keychainReads = 0;
    const cred = await resolveClaudeCredential(
      isolated({
        env: { CLAUDE_CONFIG_DIR: dir, HOME: "/nonexistent" },
        platform: "darwin",
        readKeychain: async () => {
          keychainReads += 1;
          return JSON.stringify({ claudeAiOauth: { accessToken: "tok-keychain" } });
        },
      }),
    );
    assert.equal(cred?.token, "tok-config-dir");
    assert.equal(keychainReads, 0, "must not spawn `security` when a live file credential exists");
  });
});

test("an expired config-dir credential falls through to the Keychain", async () => {
  await withTmp(async (dir) => {
    // The documented macmini trap: Claude Code refreshes into the Keychain, so
    // a leftover on-disk token is dead while the Keychain one still works.
    writeCreds(dir, "tok-stale", Date.now() - HOUR);
    const cred = await resolveClaudeCredential(
      isolated({
        env: { CLAUDE_CONFIG_DIR: dir, HOME: "/nonexistent" },
        platform: "darwin",
        readKeychain: async () =>
          JSON.stringify({ claudeAiOauth: { accessToken: "tok-keychain", expiresAt: Date.now() + HOUR } }),
      }),
    );
    assert.equal(cred?.token, "tok-keychain");
  });
});

test("falls back to ~/.claude when the config dir has no credentials", async () => {
  await withTmp(async (home) => {
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeCreds(claudeDir, "tok-home", Date.now() + HOUR);
    await withTmp(async (emptyConfigDir) => {
      const cred = await resolveClaudeCredential(
        isolated({ env: { CLAUDE_CONFIG_DIR: emptyConfigDir, HOME: home } }),
      );
      assert.equal(cred?.token, "tok-home");
    });
  });
});

test("returns the expired credential when nothing live exists, so the caller sees a 401", async () => {
  await withTmp(async (dir) => {
    writeCreds(dir, "tok-only-and-expired", Date.now() - HOUR);
    const cred = await resolveClaudeCredential(
      isolated({ env: { CLAUDE_CONFIG_DIR: dir, HOME: "/nonexistent" } }),
    );
    assert.equal(cred?.token, "tok-only-and-expired");
  });
});

test("returns null when no credential exists anywhere", async () => {
  await withTmp(async (dir) => {
    const cred = await resolveClaudeCredential(
      isolated({ env: { CLAUDE_CONFIG_DIR: dir, HOME: join(dir, "empty-home") } }),
    );
    assert.equal(cred, null);
  });
});
