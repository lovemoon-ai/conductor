import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAuthFile, parseAuthFileContents } from "../../src/manager/auth-parser.ts";
import { makeAuthJson, writeAuthJson } from "./fixtures/make-auth.ts";

test("parseAuthFileContents extracts email, plan, fingerprint from id_token", () => {
  const raw = makeAuthJson({
    email: "foo@example.com",
    accountId: "acct-1",
    planType: "plus",
    accessToken: "atk_abcdefghijklmnopqrstuvwxyz0123456789extra",
  });
  const info = parseAuthFileContents(JSON.parse(raw));
  assert.equal(info.email, "foo@example.com");
  assert.equal(info.accountId, "acct-1");
  assert.equal(info.planType, "plus");
  assert.equal(info.accessToken?.startsWith("atk_"), true);
  assert.equal(info.identityFingerprint, "foo@example.com|acct-1");
});

test("parseAuthFile reads from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-"));
  try {
    const p = join(dir, "auth.json");
    writeAuthJson(p, { email: "a@b.com", accountId: "acct-2" });
    const info = await parseAuthFile(p);
    assert.equal(info.email, "a@b.com");
    assert.equal(info.accountId, "acct-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseAuthFileContents tolerates missing id_token", () => {
  const info = parseAuthFileContents({
    tokens: { access_token: "at_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  });
  assert.equal(info.email, undefined);
  assert.ok(info.identityFingerprint?.startsWith("tok:"));
});
