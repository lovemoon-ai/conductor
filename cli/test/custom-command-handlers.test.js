import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";

import {
  createCustomCommandHandlers,
  handleCustomCommandsRequest,
  loadCustomCommands,
  parseCustomCommandsConfig,
} from "../src/custom-command-handlers.js";

function makeFakeClient() {
  const sent = [];
  return {
    sent,
    sendJson(payload) {
      sent.push(payload);
      return Promise.resolve();
    },
  };
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "conductor-custom-commands-"));
}

async function waitForRun(handlers, runId) {
  for (let i = 0; i < 100; i += 1) {
    const response = await handlers.dispatch({ action: "status", args: { runId } });
    if (response.result?.status !== "running") {
      return response.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("custom command did not finish");
}

test("parseCustomCommandsConfig accepts mapping syntax and resolves relative paths from config file", () => {
  const commands = parseCustomCommandsConfig(
    {
      custom_commands: {
        "refresh-cache": "./scripts/refresh-cache.sh",
        "sync-models": "/Users/duino/bin/sync-models.sh",
      },
    },
    "/tmp/conductor/config.yaml",
  );

  assert.deepEqual(commands, [
    {
      key: "refresh-cache",
      scriptPath: "/tmp/conductor/scripts/refresh-cache.sh",
    },
    {
      key: "sync-models",
      scriptPath: "/Users/duino/bin/sync-models.sh",
    },
  ]);
});

test("parseCustomCommandsConfig rejects list syntax", () => {
  assert.throws(
    () => parseCustomCommandsConfig({ custom_commands: [{ key: "refresh-cache", value: "x" }] }),
    /must be a mapping/,
  );
});

test("loadCustomCommands returns an empty list when config file is missing", async () => {
  const commands = await loadCustomCommands("/tmp/definitely-missing-conductor-config.yaml");
  assert.deepEqual(commands, []);
});

test("handleCustomCommandsRequest returns list response without exposing script paths", async () => {
  const dir = await makeTempDir();
  const scriptPath = path.join(dir, "refresh-cache.sh");
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(scriptPath, "#!/bin/sh\necho refreshed\n", "utf8");
  await fs.chmod(scriptPath, 0o755);
  await fs.writeFile(configPath, `custom_commands:\n  refresh-cache: ${scriptPath}\n`, "utf8");

  const client = makeFakeClient();
  const handlers = createCustomCommandHandlers({ configPath });
  const out = await handleCustomCommandsRequest(client, handlers, {
    request_id: "req-list",
    action: "list",
  });

  assert.deepEqual(out, { result: { commands: [{ key: "refresh-cache", running: false }] } });
  assert.equal(client.sent[0].type, "custom_commands_response");
  assert.equal(client.sent[0].payload.request_id, "req-list");
  assert.deepEqual(client.sent[0].payload.result, {
    commands: [{ key: "refresh-cache", running: false }],
  });
  assert.equal(JSON.stringify(client.sent[0]).includes(scriptPath), false);
});

test("run starts a configured script and status returns stdout/stderr tails", async () => {
  const dir = await makeTempDir();
  const scriptPath = path.join(dir, "refresh-cache.sh");
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(
    scriptPath,
    "#!/bin/sh\necho refreshed\necho warning >&2\n",
    "utf8",
  );
  await fs.chmod(scriptPath, 0o755);
  await fs.writeFile(configPath, `custom_commands:\n  refresh-cache: ${scriptPath}\n`, "utf8");

  const handlers = createCustomCommandHandlers({ configPath });
  const started = await handlers.dispatch({
    action: "run",
    args: { key: "refresh-cache" },
  });

  assert.equal(started.error, undefined);
  assert.equal(started.result.started, true);
  assert.equal(started.result.key, "refresh-cache");
  assert.equal(started.result.status, "running");
  assert.equal(started.result.stdoutTail, undefined);

  const finished = await waitForRun(handlers, started.result.runId);
  assert.equal(finished.status, "completed");
  assert.equal(finished.exitCode, 0);
  assert.match(finished.stdoutTail, /refreshed/);
  assert.match(finished.stderrTail, /warning/);
});

test("run rejects missing or non-executable scripts with a remote error", async () => {
  const dir = await makeTempDir();
  const scriptPath = path.join(dir, "not-executable.sh");
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(scriptPath, "#!/bin/sh\necho nope\n", "utf8");
  await fs.writeFile(configPath, `custom_commands:\n  broken: ${scriptPath}\n`, "utf8");

  const handlers = createCustomCommandHandlers({ configPath });
  const response = await handlers.dispatch({ action: "run", args: { key: "broken" } });

  assert.match(response.error, /not executable/);
});

test("run strips inherited CONDUCTOR_* internals from custom command env", async () => {
  const dir = await makeTempDir();
  const scriptPath = path.join(dir, "refresh-cache.sh");
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(scriptPath, "#!/bin/sh\necho ok\n", "utf8");
  await fs.chmod(scriptPath, 0o755);
  await fs.writeFile(configPath, `custom_commands:\n  refresh-cache: ${scriptPath}\n`, "utf8");

  const oldAgentToken = process.env.CONDUCTOR_AGENT_TOKEN;
  const oldBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
  process.env.CONDUCTOR_AGENT_TOKEN = "secret-token";
  process.env.CONDUCTOR_BACKEND_URL = "https://backend.example";
  let capturedEnv = null;
  try {
    const handlers = createCustomCommandHandlers({
      configPath,
      spawnFn: (_cmd, _args, opts) => {
        capturedEnv = opts.env;
        const child = new EventEmitter();
        child.pid = 12345;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => child.emit("close", 0, null));
        return child;
      },
    });

    const response = await handlers.dispatch({ action: "run", args: { key: "refresh-cache" } });
    assert.equal(response.error, undefined);
    assert.equal(capturedEnv.CONDUCTOR_AGENT_TOKEN, undefined);
    assert.equal(capturedEnv.CONDUCTOR_BACKEND_URL, undefined);
    assert.equal(capturedEnv.CONDUCTOR_CONFIG_FILE, configPath);
    assert.equal(capturedEnv.CONDUCTOR_CUSTOM_COMMAND_KEY, "refresh-cache");
  } finally {
    if (oldAgentToken === undefined) delete process.env.CONDUCTOR_AGENT_TOKEN;
    else process.env.CONDUCTOR_AGENT_TOKEN = oldAgentToken;
    if (oldBackendUrl === undefined) delete process.env.CONDUCTOR_BACKEND_URL;
    else process.env.CONDUCTOR_BACKEND_URL = oldBackendUrl;
  }
});

test("handleCustomCommandsRequest drops request when request_id is missing", async () => {
  const client = makeFakeClient();
  const handlers = createCustomCommandHandlers({ configPath: "/tmp/missing.yaml" });
  const out = await handleCustomCommandsRequest(client, handlers, { action: "list" });
  assert.equal(client.sent.length, 0);
  assert.equal(out.error, "missing request_id");
});
