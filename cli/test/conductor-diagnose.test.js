import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIAGNOSE_CLI_PATH = path.resolve(__dirname, "..", "bin", "conductor-diagnose.js");

const TASK_ID = "11111111-2222-3333-4444-555555555555";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("conductor diagnose --config-file", () => {
  let fileBackend;
  let envBackend;
  let fileBackendRequests;
  let envBackendHits;
  let configPath;
  let tempDir;

  before(async () => {
    fileBackendRequests = [];
    envBackendHits = 0;

    fileBackend = await startServer((req, res) => {
      fileBackendRequests.push({ url: req.url, authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          task: { id: TASK_ID, status: "running" },
          diagnosis: { code: "no_pending_user", confidence: "high", summary: "ok" },
        }),
      );
    });

    envBackend = await startServer((req, res) => {
      envBackendHits += 1;
      res.statusCode = 404;
      res.end("{}");
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-diagnose-test-"));
    configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      `agent_token: file-token\nbackend_url: "${fileBackend.url}"\n`,
    );
  });

  after(() => {
    fileBackend?.server.close();
    envBackend?.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves backend_url and agent_token from the explicit file, ignoring env overrides", async () => {
    const result = await runProcess(
      process.execPath,
      [DIAGNOSE_CLI_PATH, TASK_ID, "--config-file", configPath, "--json"],
      {
        env: {
          ...process.env,
          // Simulate a daemon-injected shell pointing at a different backend.
          CONDUCTOR_BACKEND_URL: envBackend.url,
          CONDUCTOR_AGENT_TOKEN: "env-token",
          CONDUCTOR_WS_URL: "",
        },
      },
    );

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(envBackendHits, 0, "must not query the env-injected backend");
    assert.ok(fileBackendRequests.length > 0, "must query the config file's backend");
    assert.equal(fileBackendRequests[0].authorization, "Bearer file-token");

    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "full");
    assert.equal(report.payload.task.id, TASK_ID);
  });
});
