import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  accountNameFromPath,
  listCodexAccounts,
  switchCodexAccount,
} from "../../src/manager/account.ts";
import { writeAuthJson } from "./fixtures/make-auth.ts";

test("accountNameFromPath strips auth_ prefix and .json suffix", () => {
  assert.equal(accountNameFromPath("/x/y/auth_foo.json"), "foo");
  assert.equal(accountNameFromPath("/x/bar.json"), "bar");
  assert.equal(accountNameFromPath("auth_my_name.json"), "my_name");
});

test("listCodexAccounts marks current account and reads metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-"));
  try {
    const aPath = join(dir, "auth_a.json");
    const bPath = join(dir, "auth_b.json");
    const currentPath = join(dir, "current.json");
    writeAuthJson(aPath, {
      email: "a@x.com",
      accessToken: "tokA_" + "a".repeat(50),
      accountId: "acct-a",
    });
    writeAuthJson(bPath, {
      email: "b@x.com",
      accessToken: "tokB_" + "b".repeat(50),
      accountId: "acct-b",
    });
    // Current points at account B.
    writeAuthJson(currentPath, {
      email: "b@x.com",
      accessToken: "tokB_" + "b".repeat(50),
      accountId: "acct-b",
    });

    const accounts = await listCodexAccounts(
      { codex: { authJson: [aPath, bPath] } },
      currentPath,
    );
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0]!.name, "a");
    assert.equal(accounts[0]!.email, "a@x.com");
    assert.equal(accounts[0]!.isCurrent, false);
    assert.equal(accounts[1]!.name, "b");
    assert.equal(accounts[1]!.isCurrent, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switchCodexAccount atomically swaps auth.json and writes backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-"));
  try {
    const aPath = join(dir, "auth_a.json");
    const bPath = join(dir, "auth_b.json");
    const currentPath = join(dir, "current.json");
    writeAuthJson(aPath, { email: "a@x.com", accessToken: "tokA_" + "a".repeat(50) });
    writeAuthJson(bPath, { email: "b@x.com", accessToken: "tokB_" + "b".repeat(50) });
    writeAuthJson(currentPath, { email: "a@x.com", accessToken: "tokA_" + "a".repeat(50) });

    const config = { codex: { authJson: [aPath, bPath] } };
    const res = await switchCodexAccount(config, "b", currentPath);
    assert.equal(res.newName, "b");
    assert.equal(res.previousName, "a");
    assert.equal(res.backupPath, currentPath + ".bak");
    assert.ok(existsSync(res.backupPath), "backup file exists");

    const now = JSON.parse(readFileSync(currentPath, "utf8"));
    assert.ok(now.tokens.access_token.startsWith("tokB_"));

    const bak = JSON.parse(readFileSync(res.backupPath, "utf8"));
    assert.ok(bak.tokens.access_token.startsWith("tokA_"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switchCodexAccount is a no-op when target equals current", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-"));
  try {
    const aPath = join(dir, "auth_a.json");
    const currentPath = join(dir, "current.json");
    writeAuthJson(aPath, { accessToken: "tokA_" + "a".repeat(50) });
    writeAuthJson(currentPath, { accessToken: "tokA_" + "a".repeat(50) });

    const config = { codex: { authJson: [aPath] } };
    const res = await switchCodexAccount(config, "a", currentPath);
    assert.equal(res.newName, "a");
    // Backup should NOT be created because we short-circuited.
    assert.equal(existsSync(currentPath + ".bak"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switchCodexAccount rejects unknown name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-"));
  try {
    const aPath = join(dir, "auth_a.json");
    const currentPath = join(dir, "current.json");
    writeAuthJson(aPath, { accessToken: "tokA_" + "a".repeat(50) });
    writeAuthJson(currentPath, { accessToken: "tokA_" + "a".repeat(50) });

    await assert.rejects(
      () => switchCodexAccount({ codex: { authJson: [aPath] } }, "nope", currentPath),
      /not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
