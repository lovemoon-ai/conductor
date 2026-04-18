import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAiManagerConfig } from "../src/config.ts";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("loadAiManagerConfig returns empty when file missing", async () => {
  const cfg = await loadAiManagerConfig("/no/such/path/config.yaml");
  assert.deepEqual(cfg, { codex: { authJson: [] } });
});

test("loadAiManagerConfig parses codex.auth_json list", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "config.yaml");
    writeFileSync(
      p,
      [
        "agent_token: tkn",
        "ai_manager:",
        "  codex:",
        "    auth_json:",
        "      - /abs/a.json",
        "      - /abs/b.json",
        "      - ~/rel.json",
      ].join("\n"),
    );
    const cfg = await loadAiManagerConfig(p);
    assert.equal(cfg.codex.authJson.length, 3);
    assert.equal(cfg.codex.authJson[0], "/abs/a.json");
    assert.equal(cfg.codex.authJson[1], "/abs/b.json");
    assert.ok(cfg.codex.authJson[2]!.startsWith("/"), "~ should expand to an absolute path");
  });
});

test("loadAiManagerConfig returns empty when ai_manager section missing", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, "agent_token: tkn\n");
    const cfg = await loadAiManagerConfig(p);
    assert.deepEqual(cfg, { codex: { authJson: [] } });
  });
});

test("loadAiManagerConfig rejects non-list auth_json", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, "ai_manager:\n  codex:\n    auth_json: not-a-list\n");
    await assert.rejects(() => loadAiManagerConfig(p), /must be a list/);
  });
});
