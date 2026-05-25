import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AiManager } from "../../src/manager/manager.ts";
import { writeAuthJson } from "./fixtures/make-auth.ts";

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("AiManager re-reads config on every getConfig() so edits take effect without restart", async () => {
  await withTmp(async (dir) => {
    const configPath = join(dir, "config.yaml");
    const authA = join(dir, "auth_a.json");
    const authB = join(dir, "auth_b.json");
    const codexAuth = join(dir, "codex-auth.json");
    writeAuthJson(authA, { email: "a@x.com", accessToken: "tokA_" + "a".repeat(50) });
    writeAuthJson(authB, { email: "b@x.com", accessToken: "tokB_" + "b".repeat(50) });
    writeAuthJson(codexAuth, { email: "a@x.com", accessToken: "tokA_" + "a".repeat(50) });

    writeFileSync(
      configPath,
      ["ai_manager:", "  codex:", "    auth_json:", `      - ${authA}`].join("\n"),
    );

    const m = new AiManager({ configPath, codexAuthPath: codexAuth });
    let accounts = await m.listCodexAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.name, "a");

    // Edit config to add a second profile.
    writeFileSync(
      configPath,
      [
        "ai_manager:",
        "  codex:",
        "    auth_json:",
        `      - ${authA}`,
        `      - ${authB}`,
      ].join("\n"),
    );

    accounts = await m.listCodexAccounts();
    assert.equal(accounts.length, 2, "config edit should be visible without reloadConfig()");
    assert.deepEqual(accounts.map((a) => a.name).sort(), ["a", "b"]);
  });
});
