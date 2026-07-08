import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { main } from "../bin/conductor-task.js";
import { FakeBackendApi, makeCliDeps } from "./helpers/fake-backend.js";

function makeStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      cb();
    },
  });
  stream.collect = () => chunks.join("");
  return stream;
}

const seedProject = { id: "proj-1", name: "alpha", workspacePath: "/tmp/alpha", isDefault: true };

describe("conductor task send", () => {
  it("sends a positional message via the real SDK signature", async () => {
    // Review B1: previously the CLI was passing `body` as the second arg to
    // `sendTaskMessage`, which the real SDK signature
    // `(taskId, content: string, options?)` rejected at runtime. Asserting
    // against the real SDK + a fake backend prevents this regression.
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [{ id: "task-1", projectId: "proj-1", title: "T", status: "doing" }],
    });
    const code = await main(
      ["send", "task-1", "hello world", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const sent = backend.calls.find((c) => c.method === "postTaskMessage");
    assert.ok(sent);
    assert.equal(sent.taskId, "task-1");
    assert.equal(sent.body.content, "hello world");
    assert.equal(sent.body.role, "user");
    // Audit fields are namespaced (review M3) and CLI's `actor` wins (H1).
    assert.equal(sent.body.metadata.audit.actor, "cli");
  });

  it("rejects mutually exclusive --stdin and positional message", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["send", "task-1", "hello", "--stdin"],
      { stdout, stderr, ...makeCliDeps(backend, { stdin: "from-stdin" }) },
    );
    assert.equal(code, 2);
    assert.match(stderr.collect(), /only one of/i);
  });

  it("reads --from-file when provided", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cond-task-"));
    const file = path.join(tmp, "msg.txt");
    fs.writeFileSync(file, "from-file body", "utf8");
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [{ id: "task-1", projectId: "proj-1", title: "T", status: "doing" }],
    });
    const code = await main(
      ["send", "task-1", "--from-file", file, "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const sent = backend.calls.find((c) => c.method === "postTaskMessage");
    assert.equal(sent.body.content, "from-file body");
  });

  it("dry-run does not call postTaskMessage", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["send", "task-1", "hello", "--dry-run", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.dryRun, true);
    assert.equal(data.request.method, "POST");
    assert.match(data.request.url, /\/api\/tasks\/task-1\/messages$/);
    assert.equal(data.request.body.content, "hello");
    assert.equal(backend.calls.find((c) => c.method === "postTaskMessage"), undefined);
  });

  it("merges --metadata-json BUT cannot spoof audit fields", async () => {
    // Review H1: `--metadata-json '{"actor":"system"}'` previously won over
    // CLI's `actor: "cli"`. After the audit-namespace migration, the CLI's
    // `audit.actor` always wins; user metadata still flows through but
    // can't masquerade as authoritative audit info.
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      [
        "send", "task-1", "hi",
        "--metadata-json", '{"trace":"abc","actor":"system"}',
        "--json", "--dry-run",
      ],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.request.body.metadata.audit.actor, "cli");
    assert.equal(data.request.body.metadata.trace, "abc");
    // Top-level `actor` is preserved as a plain user field; the server
    // strips it before persisting (covered by web-side test).
    assert.equal(data.request.body.metadata.actor, "system");
  });

  it("rejects invalid --metadata-json", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["send", "task-1", "hi", "--metadata-json", "not-json", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 2);
    assert.match(stderr.collect(), /Invalid --metadata-json/);
  });
});

describe("conductor task insert", () => {
  it("inserts a mid-turn message via the SDK insert endpoint", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [{ id: "task-1", projectId: "proj-1", title: "T", status: "running" }],
    });
    const code = await main(
      ["insert", "task-1", "urgent note", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const sent = backend.calls.find((c) => c.method === "postTaskInsert");
    assert.ok(sent, "expected postTaskInsert to be called");
    assert.equal(sent.taskId, "task-1");
    assert.equal(sent.body.content, "urgent note");
    assert.equal(sent.body.metadata.audit.actor, "cli");
    // Must not fall back to the queue-after-turn message endpoint.
    assert.equal(backend.calls.find((c) => c.method === "postTaskMessage"), undefined);
  });

  it("forwards --target-reply-to", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [{ id: "task-1", projectId: "proj-1", title: "T", status: "running" }],
    });
    const code = await main(
      ["insert", "task-1", "note", "--target-reply-to", "msg-7", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const sent = backend.calls.find((c) => c.method === "postTaskInsert");
    assert.equal(sent.body.target_reply_to, "msg-7");
  });

  it("dry-run targets the /insert endpoint and does not call postTaskInsert", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["insert", "task-1", "hello", "--dry-run", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.dryRun, true);
    assert.equal(data.request.method, "POST");
    assert.match(data.request.url, /\/api\/tasks\/task-1\/insert$/);
    assert.equal(data.request.body.content, "hello");
    assert.equal(backend.calls.find((c) => c.method === "postTaskInsert"), undefined);
  });
});

describe("conductor task messages", () => {
  it("pulls a slice and returns JSON", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [{ id: "task-1", projectId: "proj-1", title: "T", status: "doing" }],
      messages: [
        { id: "m1", taskId: "task-1", role: "user", content: "first" },
        { id: "m2", taskId: "task-1", role: "assistant", content: "second" },
      ],
    });
    const code = await main(
      ["messages", "task-1", "--limit", "10", "--before", "m3", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.length, 2);
    const lookup = backend.calls.find((c) => c.method === "listTaskMessages");
    assert.equal(lookup.params.limit, 10);
    assert.equal(lookup.params.before, "m3");
  });
});

describe("conductor task schedule", () => {
  it("creates a delayed scheduled message", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [{ id: "task-1", projectId: "proj-1", title: "T", status: "running" }],
    });
    const code = await main(
      ["schedule", "create", "task-1", "run later", "--delay", "15m", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );

    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.id, "sched-1");
    const call = backend.calls.find((c) => c.method === "createScheduledMessage");
    assert.equal(call.taskId, "task-1");
    assert.deepEqual(call.body, {
      content: "run later",
      sourceMessageId: null,
      schedule: {
        mode: "delay",
        amount: 15,
        unit: "minute",
      },
    });
  });

  it("creates an idle interval schedule with stop conditions from stdin", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [{ id: "task-1", projectId: "proj-1", title: "T", status: "running" }],
    });
    const code = await main(
      [
        "schedule", "create", "task-1",
        "--stdin",
        "--every", "2h",
        "--if-idle",
        "--max-runs", "4",
        "--max-skips", "8",
        "--keep-when-task-stopped",
        "--json",
      ],
      { stdout, stderr, ...makeCliDeps(backend, { stdin: "ping again" }) },
    );

    assert.equal(code, 0);
    const call = backend.calls.find((c) => c.method === "createScheduledMessage");
    assert.equal(call.body.content, "ping again");
    assert.deepEqual(call.body.schedule, {
      mode: "interval",
      every: 2,
      unit: "hour",
      condition: "ai_idle",
      stop: {
        stopWhenTaskNotRunning: false,
        maxRuns: 4,
        maxSkips: 8,
      },
    });
  });

  it("lists scheduled messages for a task", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      scheduledMessages: [
        {
          id: "sched-1",
          task_id: "task-1",
          content: "later",
          kind: "once_delay",
          condition: "none",
          status: "active",
          next_run_at: "2026-01-01T01:00:00.000Z",
          run_count: 0,
          skip_count: 0,
          failure_count: 0,
          stop_when_task_not_running: true,
        },
      ],
    });
    const code = await main(
      ["schedule", "list", "task-1", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );

    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.length, 1);
    assert.equal(data[0].id, "sched-1");
    const call = backend.calls.find((c) => c.method === "listScheduledMessages");
    assert.equal(call.taskId, "task-1");
  });

  it("deletes a scheduled message", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      scheduledMessages: [
        {
          id: "sched-1",
          task_id: "task-1",
          content: "later",
          kind: "once_delay",
          condition: "none",
          status: "active",
          next_run_at: "2026-01-01T01:00:00.000Z",
          run_count: 0,
          skip_count: 0,
          failure_count: 0,
          stop_when_task_not_running: true,
        },
      ],
    });
    const code = await main(
      ["schedule", "delete", "task-1", "sched-1", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );

    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.deepEqual(data, { deleted: true, taskId: "task-1", scheduleId: "sched-1" });
    const call = backend.calls.find((c) => c.method === "deleteScheduledMessage");
    assert.equal(call.taskId, "task-1");
    assert.equal(call.scheduleId, "sched-1");
  });

  it("rejects deleting a completed scheduled message", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      scheduledMessages: [
        {
          id: "sched-1",
          task_id: "task-1",
          content: "later",
          kind: "once_delay",
          condition: "none",
          status: "completed",
          next_run_at: "2026-01-01T01:00:00.000Z",
          run_count: 1,
          skip_count: 0,
          failure_count: 0,
          stop_when_task_not_running: true,
        },
      ],
    });

    const code = await main(
      ["schedule", "delete", "task-1", "sched-1"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );

    assert.equal(code, 4);
    assert.match(stderr.collect(), /already completed, canceled, or does not exist/i);
    assert.equal(backend.scheduledMessages.length, 1);
  });

  it("rejects schedule create without exactly one mode", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["schedule", "create", "task-1", "run later", "--delay", "15m", "--every", "1h"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );

    assert.equal(code, 2);
    assert.match(stderr.collect(), /exactly one schedule mode/i);
    assert.equal(backend.calls.find((c) => c.method === "createScheduledMessage"), undefined);
  });

  it("dry-runs schedule delete without calling the backend", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["schedule", "delete", "task-1", "sched-1", "--dry-run", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );

    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.request.method, "DELETE");
    assert.match(data.request.url, /\/api\/tasks\/task-1\/scheduled-messages\/sched-1$/);
    assert.equal(backend.calls.find((c) => c.method === "deleteScheduledMessage"), undefined);
  });

  it("lets an explicit config file override CONDUCTOR_BACKEND_URL for schedule dry-run", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-task-config-"));
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "agent_token: config-token",
        "backend_url: http://localhost:6152",
        "",
      ].join("\n"),
      "utf8",
    );

    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      [
        "schedule", "create", "task-1", "run later",
        "--delay", "15m",
        "--dry-run",
        "--json",
        "--config-file", configPath,
      ],
      {
        stdout,
        stderr,
        ...makeCliDeps(backend, {
          env: {
            CONDUCTOR_AGENT_TOKEN: "env-token",
            CONDUCTOR_BACKEND_URL: "https://conductor-ai.top",
          },
        }),
      },
    );

    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.request.url, "http://localhost:6152/api/tasks/task-1/scheduled-messages");
  });
});

describe("conductor task list", () => {
  it("returns JSON list filtered by issue id", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      tasks: [
        { id: "t1", projectId: "proj-1", title: "X", status: "doing", issueId: "issue-9" },
        { id: "t2", projectId: "proj-1", title: "Y", status: "doing", issueId: "issue-other" },
      ],
    });
    const code = await main(
      ["list", "--issue", "issue-9", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    // Issue filtering happens client-side in the SDK.
    assert.equal(data.length, 1);
    assert.equal(data[0].id, "t1");
  });
});
