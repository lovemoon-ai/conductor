import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { connectFeishuChannel } from "../bin/conductor-channel.js";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "conductor-channel-"));
}

function writeConfig(dir, content) {
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function runConductorCli(args) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const cliPath = path.resolve(__dirname, "..", "bin", "conductor.js");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

describe("conductor channel connect feishu", () => {
  it("reads ~/.conductor/config.yaml by default and uploads the raw yaml", async () => {
    const tempHome = createTempDir();
    const conductorDir = path.join(tempHome, ".conductor");
    fs.mkdirSync(conductorDir, { recursive: true });
    const yaml = [
      "agent_token: token-1",
      "backend_url: https://backend.local",
      "channels:",
      "  feishu:",
      "    app_id: app-1",
      "    app_secret: secret-1",
      "    verification_token: verify-1",
      "",
    ].join("\n");
    writeConfig(conductorDir, yaml);

    let called = false;
    const result = await connectFeishuChannel({
      env: { HOME: tempHome },
      fetchImpl: async (url, init) => {
        called = true;
        assert.equal(url, "https://backend.local/api/channel/feishu/config");
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, "Bearer token-1");
        assert.deepEqual(JSON.parse(init.body), { yaml });
        return new Response(JSON.stringify({ config: { provider: "FEISHU", appId: "app-1", verificationToken: "verify-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(called, true);
    assert.equal(result.config.appId, "app-1");
  });

  it("reads config.yaml from CONDUCTOR_HOME", async () => {
    const conductorHome = createTempDir();
    const yaml = [
      "agent_token: token-home",
      "backend_url: https://backend.custom-home",
      "channels:",
      "  feishu:",
      "    app_id: app-home",
      "    app_secret: secret-home",
      "    verification_token: verify-home",
      "",
    ].join("\n");
    writeConfig(conductorHome, yaml);

    const result = await connectFeishuChannel({
      env: { HOME: "/tmp/ignored-home", CONDUCTOR_HOME: conductorHome },
      fetchImpl: async (url) => {
        assert.equal(url, "https://backend.custom-home/api/channel/feishu/config");
        return new Response(JSON.stringify({ config: { appId: "app-home" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(result.configPath, path.join(conductorHome, "config.yaml"));
    assert.equal(result.config.appId, "app-home");
  });

  it("supports --config-file override", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfig(tempDir, [
      "agent_token: token-2",
      "backend_url: https://backend.override",
      "channels:",
      "  feishu:",
      "    app_id: app-2",
      "    app_secret: secret-2",
      "    verification_token: verify-2",
      "",
    ].join("\n"));

    const result = await connectFeishuChannel({
      configFile: configPath,
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://backend.override/api/channel/feishu/config");
        assert.equal(init.headers.Authorization, "Bearer token-2");
        return new Response(JSON.stringify({ config: { provider: "FEISHU", appId: "app-2", verificationToken: "verify-2" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(result.config.verificationToken, "verify-2");
  });

  it("fails when channels.feishu is missing", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfig(tempDir, [
      "agent_token: token-3",
      "backend_url: https://backend.local",
      "",
    ].join("\n"));

    await assert.rejects(
      () => connectFeishuChannel({ configFile: configPath, fetchImpl: async () => new Response("{}") }),
      /channels\.feishu/,
    );
  });

  it("surfaces backend error responses", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfig(tempDir, [
      "agent_token: token-4",
      "backend_url: https://backend.local",
      "channels:",
      "  feishu:",
      "    app_id: app-4",
      "    app_secret: secret-4",
      "    verification_token: verify-4",
      "",
    ].join("\n"));

    await assert.rejects(
      () => connectFeishuChannel({
        configFile: configPath,
        fetchImpl: async () => new Response(JSON.stringify({ error: "denied" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      }),
      /denied/,
    );
  });

  it("shows channel in top-level help", async () => {
    const { stdout } = await runConductorCli(["--help"]);
    assert.match(stdout, /channel/);
  });
});
