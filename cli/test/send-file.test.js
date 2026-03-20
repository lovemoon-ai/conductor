import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectTaskId, main, sendFileToTask } from "../bin/conductor-send-file.js";

describe("conductor send-file", () => {
  it("prefers CONDUCTOR_TASK_ID from environment", () => {
    const taskId = detectTaskId({
      cwd: "/tmp",
      env: { CONDUCTOR_TASK_ID: "task-from-env" },
    });
    assert.equal(taskId, "task-from-env");
  });

  it("falls back to .conductor/state task markers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-send-file-state-"));
    const stateDir = path.join(tempDir, ".conductor", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "active-fire.task_12345678-1234-1234-1234-1234567890ab.json"),
      "{}",
      "utf8",
    );

    const taskId = detectTaskId({
      cwd: tempDir,
      env: {},
    });

    assert.equal(taskId, "12345678-1234-1234-1234-1234567890ab");
  });

  it("ignores non-fire state files when auto-detecting the task id", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-send-file-stale-state-"));
    const stateDir = path.join(tempDir, ".conductor", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "agent-upstream-outbox.task_12345678-1234-1234-1234-1234567890ab.json"),
      "{}",
      "utf8",
    );

    const taskId = detectTaskId({
      cwd: tempDir,
      env: {},
    });

    assert.equal(taskId, "");
  });

  it("does not fall back to historical conductor.log entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-send-file-log-"));
    fs.writeFileSync(
      path.join(tempDir, "conductor.log"),
      "2026-03-10T12:00:00Z Attached to Conductor task 12345678-1234-1234-1234-1234567890ab\n",
      "utf8",
    );

    const taskId = detectTaskId({
      cwd: tempDir,
      env: {},
    });

    assert.equal(taskId, "");
  });

  it("uploads a file to the resolved task session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-send-file-upload-"));
    const filePath = path.join(tempDir, "image.png");
    fs.writeFileSync(filePath, "png-data", "utf8");

    const calls = [];
    const result = await sendFileToTask({
      filePath,
      env: {
        CONDUCTOR_TASK_ID: "task-1",
        CONDUCTOR_AGENT_TOKEN: "token-1",
        CONDUCTOR_BACKEND_URL: "https://conductor.example/",
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            id: "msg-1",
            attachments: [{ id: "att-1", name: "image.png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    assert.equal(result.taskId, "task-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://conductor.example/api/tasks/task-1/attachments");
    assert.equal(calls[0].init.headers.Authorization, "Bearer token-1");
    assert.equal(calls[0].init.body.get("role"), "sdk");
    assert.equal(calls[0].init.body.get("file").name, "image.png");
  });

  it("accepts a positional file argument in the CLI entrypoint", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-send-file-main-"));
    const filePath = path.join(tempDir, "positional.png");
    fs.writeFileSync(filePath, "png-data", "utf8");

    const originalTaskId = process.env.CONDUCTOR_TASK_ID;
    const originalAgentToken = process.env.CONDUCTOR_AGENT_TOKEN;
    const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
    const originalFetch = global.fetch;
    const originalStdoutWrite = process.stdout.write;
    const chunks = [];

    process.env.CONDUCTOR_TASK_ID = "task-main";
    process.env.CONDUCTOR_AGENT_TOKEN = "token-main";
    process.env.CONDUCTOR_BACKEND_URL = "https://conductor.example/";
    global.fetch = async () =>
      new Response(JSON.stringify({ id: "msg-main", attachments: [{ id: "att-main", name: "positional.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    process.stdout.write = (chunk, encoding, callback) => {
      chunks.push(String(chunk));
      if (typeof callback === "function") {
        callback();
      }
      return true;
    };

    try {
      await main([filePath, "--json"]);
    } finally {
      global.fetch = originalFetch;
      process.stdout.write = originalStdoutWrite;
      if (originalTaskId === undefined) {
        delete process.env.CONDUCTOR_TASK_ID;
      } else {
        process.env.CONDUCTOR_TASK_ID = originalTaskId;
      }
      if (originalAgentToken === undefined) {
        delete process.env.CONDUCTOR_AGENT_TOKEN;
      } else {
        process.env.CONDUCTOR_AGENT_TOKEN = originalAgentToken;
      }
      if (originalBackendUrl === undefined) {
        delete process.env.CONDUCTOR_BACKEND_URL;
      } else {
        process.env.CONDUCTOR_BACKEND_URL = originalBackendUrl;
      }
    }

    assert.match(chunks.join(""), /"taskId": "task-main"/);
  });
});
