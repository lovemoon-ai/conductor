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
