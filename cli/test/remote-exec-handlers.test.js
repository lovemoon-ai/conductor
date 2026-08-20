import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  buildExecEnv,
  clampWaitMs,
  createRemoteExecHandlers,
  handleRemoteExecRequest,
  normalizeArgv,
  normalizeCommand,
  resolveWorkspace,
} from "../src/remote-exec-handlers.js";

const NUL = String.fromCharCode(0);

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
  return fs.mkdtemp(path.join(os.tmpdir(), "conductor-remote-exec-"));
}

async function waitForRun(handlers, runId) {
  for (let i = 0; i < 100; i += 1) {
    const response = await handlers.dispatch({ action: "status", args: { runId } });
    if (response.result?.status !== "running") {
      return response.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("remote exec run did not finish");
}

test("exec runs a command in the requested workspace and returns its output", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, "marker.txt"), "hello\n", "utf8");
  const handlers = createRemoteExecHandlers();

  const response = await handlers.dispatch({
    action: "exec",
    args: { command: "ls", args: ["."], workspace: dir },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.status, "completed");
  assert.equal(response.result.exitCode, 0);
  assert.equal(response.result.workspace, path.resolve(dir));
  assert.match(response.result.stdoutTail, /marker\.txt/);
  assert.equal(response.result.truncated, false);
});

test("exec reports a non-zero exit code as a failed run without throwing", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();

  const response = await handlers.dispatch({
    action: "exec",
    args: {
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
      workspace: dir,
    },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.status, "failed");
  assert.equal(response.result.exitCode, 3);
  assert.match(response.result.stderrTail, /boom/);
});

test("exec returns a running snapshot when the command outlives the wait, then status settles it", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();

  const response = await handlers.dispatch({
    action: "exec",
    args: {
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 300)"],
      workspace: dir,
      timeoutMs: 30,
    },
  });

  assert.equal(response.result.status, "running");
  assert.ok(response.result.runId);

  const settled = await waitForRun(handlers, response.result.runId);
  assert.equal(settled.status, "completed");
  assert.equal(settled.exitCode, 0);
});

test("exec rejects a missing command and an unknown workspace", async () => {
  const handlers = createRemoteExecHandlers();

  const noCommand = await handlers.dispatch({ action: "exec", args: {} });
  assert.match(noCommand.error, /requires a `command`/);

  const badWorkspace = await handlers.dispatch({
    action: "exec",
    args: { command: "ls", workspace: "/definitely-missing-conductor-workspace" },
  });
  assert.match(badWorkspace.error, /workspace does not exist/);
});

test("exec surfaces a spawn failure instead of hanging", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();

  const response = await handlers.dispatch({
    action: "exec",
    args: { command: "conductor-definitely-not-a-real-binary", workspace: dir },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.status, "failed");
  assert.match(response.result.error, /ENOENT/);
});

test("dispatch rejects unknown actions and status requires a known runId", async () => {
  const handlers = createRemoteExecHandlers();

  assert.match((await handlers.dispatch({ action: "nope" })).error, /unknown action/);
  assert.match((await handlers.dispatch({ action: "status", args: {} })).error, /requires a `runId`/);
  assert.match(
    (await handlers.dispatch({ action: "status", args: { runId: "missing" } })).error,
    /run not found/,
  );
});

test("handleRemoteExecRequest replies with remote_exec_response carrying the run result", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();
  const client = makeFakeClient();

  await handleRemoteExecRequest(client, handlers, {
    request_id: "req-1",
    action: "exec",
    args: { command: "pwd", workspace: dir },
  });

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].type, "remote_exec_response");
  assert.equal(client.sent[0].payload.request_id, "req-1");
  assert.equal(client.sent[0].payload.action, "exec");
  assert.equal(client.sent[0].payload.result.status, "completed");
});

test("handleRemoteExecRequest ignores payloads without a request_id", async () => {
  const handlers = createRemoteExecHandlers();
  const client = makeFakeClient();

  const response = await handleRemoteExecRequest(client, handlers, { action: "exec" });

  assert.equal(response.error, "missing request_id");
  assert.equal(client.sent.length, 0);
});

test("buildExecEnv strips CONDUCTOR_* so the agent token never reaches the command", () => {
  process.env.CONDUCTOR_AGENT_TOKEN = "secret-token";
  try {
    const env = buildExecEnv({ EXTRA: "1" });
    assert.equal(env.CONDUCTOR_AGENT_TOKEN, undefined);
    assert.equal(env.EXTRA, "1");
  } finally {
    delete process.env.CONDUCTOR_AGENT_TOKEN;
  }
});

test("buildExecEnv rejects malformed overrides", () => {
  assert.throws(() => buildExecEnv({ "BAD=NAME": "x" }), /invalid env variable name/);
  assert.throws(() => buildExecEnv({ OK: 5 }), /must be a string/);
});

test("normalizeCommand and normalizeArgv reject NUL bytes", () => {
  assert.equal(normalizeCommand(`ls${NUL}`), "");
  assert.equal(normalizeCommand("  ls  "), "ls");
  assert.equal(normalizeCommand(42), "");
  assert.deepEqual(normalizeArgv(undefined), []);
  assert.throws(() => normalizeArgv("nope"), /must be an array/);
  assert.throws(() => normalizeArgv([1]), /only strings/);
  assert.throws(() => normalizeArgv([`a${NUL}`]), /NUL bytes/);
});

test("clampWaitMs falls back to a default and caps the upper bound", () => {
  assert.equal(clampWaitMs(undefined), 30_000);
  assert.equal(clampWaitMs(0), 30_000);
  assert.equal(clampWaitMs(-5), 30_000);
  assert.equal(clampWaitMs(500), 500);
  assert.equal(clampWaitMs(10_000_000), 120_000);
});

test("cancel stops a running command and reports it as cancelled", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();

  const started = await handlers.dispatch({
    action: "exec",
    args: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      workspace: dir,
      timeoutMs: 30,
    },
  });
  assert.equal(started.result.status, "running");

  const cancelled = await handlers.dispatch({
    action: "cancel",
    args: { runId: started.result.runId },
  });

  assert.equal(cancelled.error, undefined);
  assert.equal(cancelled.result.status, "cancelled");
  assert.equal(cancelled.result.signal, "SIGTERM");

  // The status action must keep reporting the terminal state afterwards.
  const after = await handlers.dispatch({ action: "status", args: { runId: started.result.runId } });
  assert.equal(after.result.status, "cancelled");
});

test("cancel on an already finished run is a no-op, and on an unknown run errors", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();

  const done = await handlers.dispatch({
    action: "exec",
    args: { command: "pwd", workspace: dir },
  });
  assert.equal(done.result.status, "completed");

  const cancelled = await handlers.dispatch({
    action: "cancel",
    args: { runId: done.result.runId },
  });
  assert.equal(cancelled.result.status, "completed");

  const missing = await handlers.dispatch({ action: "cancel", args: { runId: "nope" } });
  assert.match(missing.error, /run not found/);
});

test("exec refuses to start once too many runs are concurrently running", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();

  const started = [];
  for (let i = 0; i < 32; i += 1) {
    const response = await handlers.dispatch({
      action: "exec",
      args: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        workspace: dir,
        timeoutMs: 10,
      },
    });
    assert.equal(response.result.status, "running");
    started.push(response.result.runId);
  }

  const rejected = await handlers.dispatch({
    action: "exec",
    args: { command: "pwd", workspace: dir },
  });
  assert.match(rejected.error, /too many concurrent remote exec runs/);

  await Promise.all(started.map((runId) => handlers.dispatch({ action: "cancel", args: { runId } })));

  // Once they are cancelled the daemon accepts work again.
  const accepted = await handlers.dispatch({ action: "exec", args: { command: "pwd", workspace: dir } });
  assert.equal(accepted.result.status, "completed");
});

test("multi-byte output split across chunks is decoded without replacement characters", async () => {
  const dir = await makeTempDir();
  const handlers = createRemoteExecHandlers();

  // Emit one 3-byte character at a time with flushes, so the runtime is very
  // likely to split a character across two `data` events.
  const response = await handlers.dispatch({
    action: "exec",
    args: {
      command: process.execPath,
      args: [
        "-e",
        "for (let i = 0; i < 2000; i += 1) { process.stdout.write('\\u4e2d'); }",
      ],
      workspace: dir,
      timeoutMs: 15_000,
    },
  });

  assert.equal(response.result.status, "completed");
  assert.equal(response.result.stdoutTail.length, 2000);
  assert.ok(
    !response.result.stdoutTail.includes("�"),
    "no U+FFFD replacement characters may appear",
  );
});

test("resolveWorkspace expands ~ and rejects non-directories", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "file.txt");
  await fs.writeFile(filePath, "x", "utf8");

  assert.equal(await resolveWorkspace("~", "/tmp"), path.resolve(os.homedir()));
  assert.equal(await resolveWorkspace("", dir), path.resolve(dir));
  await assert.rejects(() => resolveWorkspace(filePath, dir), /not a directory/);
});
