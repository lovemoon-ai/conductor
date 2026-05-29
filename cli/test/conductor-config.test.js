import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_CLI_PATH = path.resolve(__dirname, "..", "bin", "conductor-config.js");

function createFakeCliBinDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-config-bin-"));
  for (const name of ["codex", "claude", "kimi", "opencode", "copilot"]) {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return tempDir;
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
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`process exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function runInteractiveProcess(command, args, { prompts, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let promptIndex = 0;

    const maybeRespond = () => {
      while (promptIndex < prompts.length) {
        const prompt = prompts[promptIndex];
        if (!stdout.includes(prompt.waitFor) && !stderr.includes(prompt.waitFor)) {
          return;
        }
        child.stdin.write(prompt.reply);
        promptIndex += 1;
      }

      if (promptIndex === prompts.length) {
        child.stdin.end();
      }
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      maybeRespond();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      maybeRespond();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    maybeRespond();
  });
}

describe("conductor-config", () => {
  it("writes allow_cli_list as a nested map in YAML when using manual token entry", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-config-home-"));
    const fakeBinDir = createFakeCliBinDir();
    const env = {
      ...process.env,
      HOME: tempHome,
      PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
    };

    execFileSync(process.execPath, [CONFIG_CLI_PATH, "--manual"], {
      env,
      input: "test-token\n",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const configPath = path.join(tempHome, ".conductor", "config.yaml");
    assert.ok(fs.existsSync(configPath), "config.yaml was not created");

    const configContent = fs.readFileSync(configPath, "utf8");
    assert.match(
      configContent,
      /# opencode runs via ai-sdk server mode with permission=allow/,
    );
    const parsed = yaml.load(configContent);
    assert.ok(parsed && typeof parsed === "object", "config.yaml is not valid YAML");
    assert.equal(typeof parsed.daemon_name, "string");
    assert.ok(parsed.daemon_name.length > 0);

    const allowCliList = parsed.allow_cli_list;
    assert.ok(allowCliList && typeof allowCliList === "object", "allow_cli_list should be an object");
    assert.equal(typeof allowCliList.codex, "string");
    assert.equal(typeof allowCliList.claude, "string");
    assert.equal(typeof allowCliList.kimi, "string");
    assert.equal(typeof allowCliList.opencode, "string");
    assert.equal(typeof allowCliList.copilot, "string");
    // chat-web ships as an optional dependency of conductor-cli, so the two
    // canonical sub-provider aliases should be written by default. The bare
    // `chat-web` backend name is intentionally NOT advertised — users must go
    // through an explicit alias that pins a --model choice. Regression guard
    // for m1-chat-web-backends-not-advertised-20260525.
    assert.equal(allowCliList["web-chatgpt"], "chat-web --model chatgpt");
    assert.equal(allowCliList["web-gemini"], "chat-web --model gemini");
    assert.equal(allowCliList["chat-web"], undefined);
  });

  it("treats builtin copilot as available even when no PATH CLI is installed", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-config-home-"));
    const env = {
      ...process.env,
      HOME: tempHome,
      PATH: "",
    };

    const output = execFileSync(process.execPath, [CONFIG_CLI_PATH, "--manual"], {
      env,
      input: "test-token\n",
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();

    const configPath = path.join(tempHome, ".conductor", "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf8");
    assert.doesNotMatch(output, /No coding CLI detected/);
    assert.match(configContent, /copilot: copilot/);
  });

  it("authorizes the device in the browser flow and writes backend/websocket config", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-config-home-"));
    const fakeBinDir = createFakeCliBinDir();
    let pollCount = 0;

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        res.setHeader("Content-Type", "application/json");

        if (req.method === "POST" && req.url === "/api/auth/device/start") {
          assert.equal(body.hostname.length > 0, true);
          res.end(
            JSON.stringify({
              device_code: "device-code-1",
              user_code: "ABCD-EFGH",
              verification_uri: `http://127.0.0.1:${server.address().port}/activate`,
              verification_uri_complete: `http://127.0.0.1:${server.address().port}/activate?user_code=ABCD-EFGH`,
              expires_in: 30,
              interval: 1,
            }),
          );
          return;
        }

        if (req.method === "POST" && req.url === "/api/auth/device/poll") {
          pollCount += 1;
          if (pollCount === 1) {
            res.end(JSON.stringify({ status: "pending" }));
            return;
          }
          res.end(
            JSON.stringify({
              status: "approved",
              agent_token: "device-token-1",
              backend_url: `http://127.0.0.1:${server.address().port}`,
              websocket_url: `ws://127.0.0.1:${server.address().port}/ws/agent`,
            }),
          );
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const env = {
        ...process.env,
        HOME: tempHome,
        PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
        CONDUCTOR_BACKEND_URL: `http://127.0.0.1:${port}`,
      };

      const { stdout } = await runProcess(process.execPath, [CONFIG_CLI_PATH], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const configPath = path.join(tempHome, ".conductor", "config.yaml");
      const parsed = yaml.load(fs.readFileSync(configPath, "utf8"));
      assert.equal(parsed.agent_token, "device-token-1");
      assert.equal(parsed.backend_url, `http://127.0.0.1:${port}`);
      assert.equal(parsed.websocket_url, `ws://127.0.0.1:${port}/ws/agent`);
      assert.match(stdout, /Device code:\s+\x1b\[1mABCD-EFGH/);
      assert.match(stdout, /Only approve the request if the web page shows the same device code\./);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("does not start browser authorization when no local coding CLI is detected and the user cancels", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-config-home-"));
    const env = {
      ...process.env,
      HOME: tempHome,
      PATH: "",
      CONDUCTOR_BACKEND_URL: "http://127.0.0.1:1",
    };

    const { code } = await runInteractiveProcess(process.execPath, [CONFIG_CLI_PATH], {
      env,
      prompts: [
        { waitFor: "Do you want to install opencode now? (Y/n): ", reply: "n\n" },
        { waitFor: "Do you want to continue creating the config anyway? (y/N): ", reply: "n\n" },
      ],
    });

    const configPath = path.join(tempHome, ".conductor", "config.yaml");
    assert.equal(code, 1);
    assert.equal(fs.existsSync(configPath), false);
  });
});
