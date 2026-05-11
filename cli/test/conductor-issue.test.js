import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { main } from "../bin/conductor-issue.js";
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

describe("conductor issue create", () => {
  it("dry-run --json prints request preview without sending", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      [
        "create",
        "--title", "Refactor module",
        "--priority", "P2",
        "--description", "long desc",
        "--client-request-id", "k1",
        "--json", "--dry-run",
      ],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.dryRun, true);
    assert.equal(data.request.method, "POST");
    assert.match(data.request.url, /\/api\/issues$/);
    assert.equal(data.request.body.title, "Refactor module");
    assert.equal(data.request.body.priority, "P2");
    assert.equal(data.request.body.description, "long desc");
    assert.equal(data.request.body.clientRequestId, "k1");
    assert.equal(data.request.body.projectId, "proj-1");
    // Audit fields are namespaced (review M3) and `actor: "cli"` wins (H1).
    assert.equal(data.request.body.metadata.audit.actor, "cli");
    assert.equal(data.request.body.metadata.actor, undefined);
    // Dry-run never reaches HTTP.
    assert.equal(backend.calls.find((c) => c.method === "createIssue"), undefined);
  });

  it("rejects mutually exclusive description sources", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["create", "--title", "T", "--description", "x", "--description-stdin"],
      { stdout, stderr, ...makeCliDeps(backend, { stdin: "stdin-body" }) },
    );
    assert.equal(code, 2);
    assert.match(stderr.collect(), /only one of/i);
  });

  it("reads --description-file when provided", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cond-issue-"));
    const file = path.join(tmp, "d.md");
    fs.writeFileSync(file, "from-file body", "utf8");
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["create", "--title", "T", "--description-file", file, "--json", "--dry-run"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.request.body.description, "from-file body");
  });

  it("actually calls createIssue when dry-run absent", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["create", "--title", "T", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const created = backend.calls.find((c) => c.method === "createIssue");
    assert.ok(created);
    assert.equal(created.body.title, "T");
    assert.equal(created.body.metadata.audit.actor, "cli");
    assert.equal(created.body.metadata.audit.sdkVersion !== undefined, true);
  });
});

describe("conductor issue update path picks the right SDK call", () => {
  it("update --title <T> --status doing routes through updateIssue (preserves title)", async () => {
    // Review B2: previously the CLI sent the whole body as the third arg of
    // updateIssueStatus — title was silently dropped. With the fix, multi-
    // field patches go through updateIssue, so all fields land in the PATCH
    // body.
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [{ id: "issue-1", projectId: "proj-1", title: "old", status: "todo", priority: "P1" }],
    });
    const code = await main(
      ["update", "issue-1", "--title", "new title", "--status", "doing", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const patched = backend.calls.find((c) => c.method === "patchIssue");
    assert.ok(patched);
    assert.equal(patched.body.title, "new title");
    assert.equal(patched.body.status, "doing");
    assert.equal(patched.body.metadata.audit.actor, "cli");
    // updateIssueStatus would have done a getIssue first; here we expect none
    // because we routed through plain updateIssue.
    assert.equal(backend.calls.find((c) => c.method === "getIssue"), undefined);
  });

  it("done <id> --evidence routes through updateIssueStatus + persists qa.evidence", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [
        {
          id: "issue-2",
          projectId: "proj-1",
          title: "T",
          status: "doing",
          priority: "P1",
          metadata: { custom: "kept" },
        },
      ],
    });
    const code = await main(
      ["done", "issue-2", "--evidence", "QA passed.", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    // updateIssueStatus path: SDK first GETs the existing issue to merge
    // metadata, then PATCHes with the merged shape.
    const reads = backend.calls.filter((c) => c.method === "getIssue");
    assert.ok(reads.length >= 1, "expected getIssue to be called by updateIssueStatus");
    const patch = backend.calls.find((c) => c.method === "patchIssue");
    assert.ok(patch);
    assert.equal(patch.body.status, "done");
    assert.equal(patch.body.metadata.qa.evidence, "QA passed.");
    assert.equal(patch.body.metadata.custom, "kept");
    assert.equal(patch.body.metadata.audit.actor, "cli");
  });

  it("done dry-run shows qa.evidence in the preview body + note about server merge (L-NEW-2)", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [{ id: "issue-3", projectId: "proj-1", title: "T", status: "doing", priority: "P1" }],
    });
    const code = await main(
      ["done", "issue-3", "--evidence", "all green", "--json", "--dry-run"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.request.body.status, "done");
    assert.equal(data.request.body.metadata.qa.evidence, "all green");
    // Preview faithfully flags the server-side merge so AI agents
    // inspecting dry-run don't assume they've captured the full body.
    assert.match(data.note, /metadata round-trip/i);
    // Dry-run must not hit the network at all.
    assert.equal(backend.calls.find((c) => c.method === "patchIssue"), undefined);
  });

  it("start <id> sets status doing without dropping audit metadata", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [{ id: "issue-4", projectId: "proj-1", title: "T", status: "todo", priority: "P1" }],
    });
    const code = await main(
      ["start", "issue-4", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const patch = backend.calls.find((c) => c.method === "patchIssue");
    assert.ok(patch);
    assert.equal(patch.body.status, "doing");
    assert.equal(patch.body.metadata.audit.actor, "cli");
  });
});

describe("conductor issue update arg-checks", () => {
  it("requires at least one updatable field", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["update", "issue-x"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 2);
    assert.match(stderr.collect(), /Nothing to update/);
  });
});

describe("conductor issue list", () => {
  it("returns the JSON array filtered by project", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [
        { id: "i1", projectId: "proj-1", title: "First", status: "todo", priority: "P1" },
        { id: "i2", projectId: "proj-1", title: "Second", status: "doing", priority: "P2" },
        { id: "i3", projectId: "proj-other", title: "Other", status: "todo", priority: "P1" },
      ],
    });
    const code = await main(
      ["list", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.length, 2);
    assert.deepEqual(data.map((entry) => entry.id), ["i1", "i2"]);
  });
});
