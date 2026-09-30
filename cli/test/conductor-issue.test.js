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
    // A pure status request: the server only (re)starts a taskless doing issue without `position`.
    assert.equal(patch.body.position, undefined);
  });

  it("start --global-backend sends globalBackend and its backend type", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [{
        id: "issue-5", projectId: "proj-1", title: "T", status: "todo", priority: "P1",
        // What the server echoes once the task runs on the global backend.
        activeTask: { id: "task-1", agentHost: "ubuntu" },
      }],
    });
    const code = await main(
      ["start", "issue-5", "--global-backend", "Codex@ubuntu", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0, stderr.collect());
    const patch = backend.calls.find((c) => c.method === "patchIssue");
    assert.deepEqual(patch.body.globalBackend, { host: "ubuntu", backend: "codex" });
    assert.equal(patch.body.metadata.backendType, "codex");
    assert.equal(patch.body.metadata.audit.actor, "cli");
    assert.equal(stderr.collect(), "");
  });

  it("start --global-backend warns when the server started the task elsewhere", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      // An older server drops globalBackend and runs on the project's daemon.
      issues: [{
        id: "issue-8", projectId: "proj-1", title: "T", status: "todo", priority: "P1",
        activeTask: { id: "task-2", agent_host: "macmini" },
      }],
    });
    const code = await main(
      ["start", "issue-8", "--global-backend", "codex@ubuntu", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    assert.match(stderr.collect(), /did not start on codex@ubuntu \(it runs on macmini\).*too old/);
  });

  it("start --backend sets the spawned task's backend type", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [{ id: "issue-6", projectId: "proj-1", title: "T", status: "todo", priority: "P1" }],
    });
    const code = await main(
      ["start", "issue-6", "--backend", "claude", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0, stderr.collect());
    const patch = backend.calls.find((c) => c.method === "patchIssue");
    assert.equal(patch.body.globalBackend, undefined);
    assert.equal(patch.body.metadata.backendType, "claude");
  });

  it("start rejects a malformed --global-backend", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(
      ["start", "issue-7", "--global-backend", "codex"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 2);
    assert.match(stderr.collect(), /<backend>@<host>/);
    assert.equal(backend.calls.find((c) => c.method === "patchIssue"), undefined);
  });
});

describe("conductor issue start target daemon", () => {
  const mergedProjects = [
    { id: "proj-mac", name: "alpha", daemonHost: "macmini", workspacePath: "/w/alpha" },
    { id: "proj-ubu", name: "alpha", daemonHost: "ubuntu", workspacePath: "/w/alpha" },
    { id: "proj-other", name: "beta", daemonHost: "ubuntu", workspacePath: "/w/beta" },
  ];

  it("--daemon on a merged group moves the issue to the sibling project, like the web dialog", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: mergedProjects,
      issues: [{ id: "issue-d1", projectId: "proj-mac", title: "T", status: "todo", priority: "P1" }],
    });
    const code = await main(["start", "issue-d1", "--daemon", "ubuntu", "--json"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 0, stderr.collect());
    const patch = backend.calls.find((c) => c.method === "patchIssue");
    assert.equal(patch.body.status, "doing");
    assert.equal(patch.body.projectId, "proj-ubu");
    assert.equal(patch.body.metadata.daemonHost, "ubuntu");
  });

  it("--daemon on the issue's own daemon (or the default project) only sends daemonHost", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [...mergedProjects, seedProject],
      issues: [
        { id: "issue-d2", projectId: "proj-mac", title: "T", status: "todo", priority: "P1" },
        { id: "issue-d3", projectId: "proj-1", title: "T", status: "todo", priority: "P1" },
      ],
    });
    for (const id of ["issue-d2", "issue-d3"]) {
      const code = await main(["start", id, "--daemon", id === "issue-d2" ? "macmini" : "ubuntu"], { stdout, stderr, ...makeCliDeps(backend) });
      assert.equal(code, 0, stderr.collect());
    }
    const patches = backend.calls.filter((c) => c.method === "patchIssue");
    assert.deepEqual(patches.map((p) => [p.body.projectId, p.body.metadata.daemonHost]), [[undefined, "macmini"], [undefined, "ubuntu"]]);
  });

  it("--project sends the target project id; an unknown daemon is an args error", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: mergedProjects,
      issues: [{ id: "issue-d4", projectId: "proj-mac", title: "T", status: "todo", priority: "P1" }],
    });
    let code = await main(["start", "issue-d4", "--daemon", "nowhere"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 2);
    assert.match(stderr.collect(), /No project "alpha" on daemon nowhere; pass --project <id>/);
    assert.equal(backend.calls.find((c) => c.method === "patchIssue"), undefined);
    code = await main(["start", "issue-d4", "--project", "proj-ubu", "--daemon", "ubuntu"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 0, stderr.collect());
    assert.equal(backend.calls.find((c) => c.method === "patchIssue").body.projectId, "proj-ubu");
  });

  it("--daemon on another member's shared project leaves the check to the server", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    // The issue's project belongs to a collaborator, so it is not in our project list.
    const backend = new FakeBackendApi({
      projects: mergedProjects,
      issues: [{ id: "issue-d5", projectId: "proj-theirs", title: "T", status: "todo", priority: "P1" }],
    });
    const code = await main(["start", "issue-d5", "--daemon", "ubuntu"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 0, stderr.collect());
    const patch = backend.calls.find((c) => c.method === "patchIssue");
    assert.equal(patch.body.projectId, undefined);
    assert.equal(patch.body.metadata.daemonHost, "ubuntu");
  });
});

describe("conductor issue choices match the server", () => {
  it("--priority accepts P0 and rejects P3", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    let code = await main(["create", "--title", "T", "--priority", "P0", "--json", "--dry-run"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 0, stderr.collect());
    assert.equal(JSON.parse(stdout.collect().trim()).request.body.priority, "P0");
    code = await main(["create", "--title", "T", "--priority", "P3"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 2);
  });

  it("create --status doing is rejected (create, then start)", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: [seedProject] });
    const code = await main(["create", "--title", "T", "--status", "doing"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 2);
    assert.equal(backend.calls.find((c) => c.method === "createIssue"), undefined);
  });

  it("update --title keeps stored metadata (the server shallow-merges)", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [{
        id: "issue-m1", projectId: "proj-1", title: "T", status: "todo", priority: "P1",
        metadata: { backendType: "codex", daemonHost: "macmini", clientRequestId: "k1" },
      }],
    });
    const code = await main(["update", "issue-m1", "--title", "T2", "--json"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 0, stderr.collect());
    const patch = backend.calls.find((c) => c.method === "patchIssue");
    // Only the audit namespace goes over the wire; nothing to clobber with.
    assert.deepEqual(Object.keys(patch.body.metadata), ["audit"]);
    const out = JSON.parse(stdout.collect().trim());
    assert.equal(out.metadata.backendType, "codex");
    assert.equal(out.metadata.clientRequestId, "k1");
  });
});

describe("conductor issue list --status", () => {
  it("sends the comma-separated status list to the server", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [
        { id: "i1", projectId: "proj-1", title: "A", status: "todo", priority: "P1" },
        { id: "i2", projectId: "proj-1", title: "B", status: "doing", priority: "P1" },
        { id: "i3", projectId: "proj-1", title: "C", status: "done", priority: "P1" },
      ],
    });
    const code = await main(["list", "--status", "doing", "--json"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 0, stderr.collect());
    assert.equal(backend.calls.find((c) => c.method === "listIssues").params.status, "doing");
    assert.deepEqual(JSON.parse(stdout.collect().trim()).map((i) => i.id), ["i2"]);
  });

  it("still filters when an older server ignores status", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [seedProject],
      issues: [
        { id: "i1", projectId: "proj-1", title: "A", status: "todo", priority: "P1" },
        { id: "i2", projectId: "proj-1", title: "B", status: "doing", priority: "P1" },
      ],
    });
    const listIssues = backend.listIssues.bind(backend);
    backend.listIssues = (params) => listIssues({ ...params, status: undefined });
    const code = await main(["list", "--status", "doing", "--json"], { stdout, stderr, ...makeCliDeps(backend) });
    assert.equal(code, 0, stderr.collect());
    assert.deepEqual(JSON.parse(stdout.collect().trim()).map((i) => i.id), ["i2"]);
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
