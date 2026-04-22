import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SERVE_AI_CONFIG_BASENAME,
  resolveServeAiConfigPaths,
  loadServeAiRuntimeConfig,
  writeServeAiConfigFile,
} from "../src/serve-ai/config.js";

const tempPaths = [];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeTempDir(prefix = "serve-ai-config-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  while (tempPaths.length > 0) {
    fs.rmSync(tempPaths.pop(), { recursive: true, force: true });
  }
});

describe("serve-ai config", () => {
  it("resolves fallback config next to the primary config path", () => {
    const resolved = resolveServeAiConfigPaths("/tmp/custom/config.yaml");
    assert.equal(resolved.conductorConfigPath, "/tmp/custom/config.yaml");
    assert.equal(resolved.serveAiConfigPath, `/tmp/custom/${DEFAULT_SERVE_AI_CONFIG_BASENAME}`);
  });

  it("falls back to config-ai-serve.yaml when config.yaml is missing", () => {
    const dir = makeTempDir();
    const conductorConfigPath = path.join(dir, "config.yaml");
    const serveAiConfigPath = path.join(dir, DEFAULT_SERVE_AI_CONFIG_BASENAME);
    fs.writeFileSync(
      serveAiConfigPath,
      [
        "serve_ai:",
        "  backend: kimi",
        "  port: 9900",
        "allow_cli_list:",
        "  kimi: kimi",
        "envs:",
        "  TEST_ENV: fallback",
        "",
      ].join("\n"),
      "utf8",
    );

    const loaded = loadServeAiRuntimeConfig(conductorConfigPath);
    assert.equal(loaded.source, "serve-ai");
    assert.equal(loaded.activeConfigPath, serveAiConfigPath);
    assert.equal(loaded.defaults.backend, "kimi");
    assert.equal(loaded.defaults.port, 9900);
    assert.equal(loaded.allowCliList.kimi, "kimi");
    assert.equal(loaded.envs.TEST_ENV, "fallback");
  });

  it("prefers config.yaml when both files exist", () => {
    const dir = makeTempDir();
    const conductorConfigPath = path.join(dir, "config.yaml");
    const serveAiConfigPath = path.join(dir, DEFAULT_SERVE_AI_CONFIG_BASENAME);
    fs.writeFileSync(
      conductorConfigPath,
      [
        "allow_cli_list:",
        "  codex: codex",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      serveAiConfigPath,
      [
        "allow_cli_list:",
        "  kimi: kimi",
        "",
      ].join("\n"),
      "utf8",
    );

    const loaded = loadServeAiRuntimeConfig(conductorConfigPath);
    assert.equal(loaded.source, "conductor");
    assert.equal(loaded.activeConfigPath, conductorConfigPath);
    assert.equal(loaded.allowCliList.codex, "codex");
    assert.equal(loaded.allowCliList.kimi, undefined);
  });

  it("writes a dedicated serve-ai config template", () => {
    const dir = makeTempDir();
    const serveAiConfigPath = path.join(dir, DEFAULT_SERVE_AI_CONFIG_BASENAME);
    const writtenPath = writeServeAiConfigFile(serveAiConfigPath, {
      backend: "kimi",
      host: "0.0.0.0",
      port: 9999,
      apiKey: "local-dev-key",
    });

    assert.equal(writtenPath, serveAiConfigPath);
    const content = fs.readFileSync(serveAiConfigPath, "utf8");
    assert.match(content, /serve_ai:/);
    assert.match(content, /backend: kimi/);
    assert.match(content, /host: 0.0.0.0/);
    assert.match(content, /port: 9999/);
    assert.match(content, /api_key: local-dev-key/);
    assert.match(content, /allow_cli_list:/);
  });

  it("initializes config-ai-serve.yaml through the serve-ai init command", async () => {
    const dir = makeTempDir();
    const conductorConfigPath = path.join(dir, "config.yaml");
    const cliPath = path.resolve(__dirname, "..", "bin", "conductor-serve-ai.js");

    await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [cliPath, "init", "--config-file", conductorConfigPath, "--backend", "kimi", "--port", "9901"],
        { env: { ...process.env, CONDUCTOR_CLI_NAME: "conductor serve-ai" } },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });

    const serveAiConfigPath = path.join(dir, DEFAULT_SERVE_AI_CONFIG_BASENAME);
    assert.equal(fs.existsSync(serveAiConfigPath), true);
    const content = fs.readFileSync(serveAiConfigPath, "utf8");
    assert.match(content, /backend: kimi/);
    assert.match(content, /port: 9901/);
  });
});
