import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadAiManagerConfig } from "../../src/manager/config.ts";
import { cacheFile } from "../../src/manager/quota/cache.ts";
import {
  resolveConductorHome,
  resolveDefaultConductorConfig,
  resolveDefaultQuotaCacheDir,
} from "../../src/manager/paths.ts";

test("AI manager config and cache follow CONDUCTOR_HOME", async () => {
  const conductorHome = mkdtempSync(join(tmpdir(), "ai-manager-conductor-home-"));
  const previousConductorHome = process.env.CONDUCTOR_HOME;
  const previousConductorConfig = process.env.CONDUCTOR_CONFIG;
  process.env.CONDUCTOR_HOME = conductorHome;
  delete process.env.CONDUCTOR_CONFIG;

  try {
    writeFileSync(
      join(conductorHome, "config.yaml"),
      [
        "ai_manager:",
        "  codex:",
        "    auth_json:",
        "      - /tmp/custom-auth.json",
        "",
      ].join("\n"),
    );

    assert.equal(resolveConductorHome(), resolve(conductorHome));
    assert.equal(resolveDefaultConductorConfig(), join(resolve(conductorHome), "config.yaml"));
    assert.equal(
      resolveDefaultQuotaCacheDir(),
      join(resolve(conductorHome), "cache", "ai-manager"),
    );
    assert.equal(
      cacheFile("codex", "fingerprint"),
      join(resolve(conductorHome), "cache", "ai-manager", "quota-codex-fingerprint.json"),
    );

    const config = await loadAiManagerConfig();
    assert.deepEqual(config.codex.authJson, ["/tmp/custom-auth.json"]);
  } finally {
    if (previousConductorHome === undefined) {
      delete process.env.CONDUCTOR_HOME;
    } else {
      process.env.CONDUCTOR_HOME = previousConductorHome;
    }
    if (previousConductorConfig === undefined) {
      delete process.env.CONDUCTOR_CONFIG;
    } else {
      process.env.CONDUCTOR_CONFIG = previousConductorConfig;
    }
    rmSync(conductorHome, { recursive: true, force: true });
  }
});

test("CONDUCTOR_CONFIG overrides CONDUCTOR_HOME for AI manager config", () => {
  const env = {
    HOME: "/tmp/user-home",
    CONDUCTOR_HOME: "/tmp/conductor-home",
    CONDUCTOR_CONFIG: "/tmp/explicit-config.yaml",
  };
  assert.equal(resolveDefaultConductorConfig(env), resolve("/tmp/explicit-config.yaml"));
});
