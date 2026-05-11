import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { main } from "../bin/conductor-project.js";
import { FakeBackendApi, makeCliDeps } from "./helpers/fake-backend.js";

function makeStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      callback();
    },
  });
  stream.collect = () => chunks.join("");
  return stream;
}

describe("conductor project list", () => {
  it("emits JSON of non-hidden projects by default", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [
        { id: "p1", name: "alpha", isDefault: true, hidden: false },
        { id: "p2", name: "beta", isDefault: false, hidden: true },
      ],
    });
    const code = await main(["list", "--json"], {
      stdout,
      stderr,
      ...makeCliDeps(backend),
    });
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.length, 1);
    assert.equal(data[0].id, "p1");
  });

  it("includes hidden with --include-hidden", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [
        { id: "p1", name: "alpha", isDefault: true, hidden: false },
        { id: "p2", name: "beta", isDefault: false, hidden: true },
      ],
    });
    const code = await main(["list", "--json", "--include-hidden"], {
      stdout,
      stderr,
      ...makeCliDeps(backend),
    });
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.length, 2);
  });
});

describe("conductor project current", () => {
  it("prints just the id by default", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [{ id: "p1", name: "alpha", isDefault: true, hidden: false }],
    });
    const code = await main(["current"], {
      stdout,
      stderr,
      ...makeCliDeps(backend),
    });
    assert.equal(code, 0);
    assert.equal(stdout.collect().trim(), "p1");
  });
});

describe("conductor project create", () => {
  it("dry-run prints the would-be POST body without calling create", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi();
    const code = await main(
      [
        "create",
        "--name", "myproj",
        "--workspace-path", "/tmp/myproj",
        "--daemon-host", "host-1",
        "--json", "--dry-run",
      ],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.dryRun, true);
    assert.equal(data.request.method, "POST");
    assert.match(data.request.url, /\/api\/projects$/);
    assert.equal(data.request.body.name, "myproj");
    assert.equal(data.request.body.workspacePath, "/tmp/myproj");
    assert.equal(data.request.body.daemonHost, "host-1");
    // Audit fields under metadata.audit (review M3).
    assert.equal(data.request.body.metadata.audit.actor, "cli");
    assert.equal(data.request.body.metadata.actor, undefined);
    assert.equal(backend.calls.find((c) => c.method === "createProject"), undefined);
  });

  it("defaults --name to basename(workspacePath)", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi();
    const code = await main(
      ["create", "--workspace-path", "/tmp/foo-bar", "--json", "--dry-run"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.request.body.name, "foo-bar");
  });

  it("translates daemon-not-reachable errors into actionable hints", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi();
    backend.createProject = async () => {
      const err = new Error("Daemon at host-x not reachable");
      err.statusCode = 400;
      throw err;
    };
    const code = await main(
      ["create", "--workspace-path", "/tmp/x", "--daemon-host", "host-x", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.notEqual(code, 0);
    assert.match(stderr.collect(), /Daemon at host-x not reachable/);
    assert.match(stderr.collect(), /conductor daemon/);
  });
});

describe("conductor project hide", () => {
  it("dry-run for hide emits PATCH preview with hidden:true", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [{ id: "p1", name: "alpha", isDefault: false, hidden: false }],
    });
    const code = await main(
      ["hide", "p1", "--dry-run", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.dryRun, true);
    assert.equal(data.request.method, "PATCH");
    assert.equal(data.request.body.hidden, true);
    // Audit fields are namespaced; CLI's actor wins.
    assert.equal(data.request.body.metadata.audit.actor, "cli");
    assert.equal(backend.calls.find((c) => c.method === "patchProjectByQuery"), undefined);
  });

  it("hide propagates audit metadata through to the SDK transport (review H2a)", async () => {
    // Previously the CLI passed the third arg (`body` containing metadata) to
    // `setProjectHidden(idOrName, hidden)`, which the SDK silently dropped.
    // After the fix, the SDK accepts `(idOrName, hidden, options)` so audit
    // info actually reaches the `patchProjectByQuery` body.
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [{ id: "p1", name: "alpha", isDefault: false, hidden: false }],
    });
    const code = await main(
      ["hide", "p1", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const patch = backend.calls.find((c) => c.method === "patchProjectByQuery");
    assert.ok(patch);
    assert.equal(patch.body.hidden, true);
    assert.equal(patch.body.metadata.audit.actor, "cli");
  });

  it("surfaces 400 from hiding the default project", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [{ id: "p1", name: "alpha", isDefault: true, hidden: false }],
    });
    backend.patchProjectByQuery = async () => {
      const err = new Error("Default project cannot be hidden");
      err.statusCode = 400;
      throw err;
    };
    const code = await main(
      ["hide", "p1", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 2); // ARGS exit code per RFC
    assert.match(stderr.collect(), /Default project cannot be hidden/);
  });
});

describe("conductor project — multi-daemon name disambiguation", () => {
  // Same project name on two different daemons is a real situation: the
  // unique constraint is `(userId, daemonHost, name)`, so the same user
  // can legitimately have `persona` on both `4090` and `m1`. The CLI must
  // not silently pick one — it must either error with candidates, or let
  // the caller narrow via --daemon-host.
  const ambiguousProjects = [
    { id: "p1-4090", name: "persona", daemonHost: "4090", workspacePath: "/home/duino/ws/ququ/persona", hidden: false },
    { id: "p2-m1", name: "persona", daemonHost: "m1", workspacePath: "/Users/duino/ws/ark/persona", hidden: false },
  ];

  it("ambiguous name → exit 2 with candidate ids and daemons listed", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: ambiguousProjects });
    const code = await main(
      ["set-default", "persona", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 2);
    const errText = stderr.collect();
    assert.match(errText, /ambiguous/i);
    // Both candidate ids appear in the error so the user can copy-paste.
    assert.match(errText, /p1-4090/);
    assert.match(errText, /p2-m1/);
    // Each candidate line shows its daemon, not just the id.
    assert.match(errText, /daemon=4090/);
    assert.match(errText, /daemon=m1/);
    // Hint mentions both disambiguation paths.
    assert.match(errText, /--daemon-host/);
    // Nothing was written.
    assert.equal(backend.calls.find((c) => c.method === "setDefaultProject"), undefined);
  });

  it("--daemon-host narrows ambiguous name to one match", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: ambiguousProjects });
    const code = await main(
      ["set-default", "persona", "--daemon-host", "m1", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const call = backend.calls.find((c) => c.method === "setDefaultProject");
    assert.ok(call, "setDefaultProject must be called once --daemon-host picks one match");
    assert.equal(call.projectId, "p2-m1");
  });

  it("--daemon-host that excludes all matches → exit 4", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: ambiguousProjects });
    const code = await main(
      ["set-default", "persona", "--daemon-host", "no-such-daemon", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 4);
    assert.match(stderr.collect(), /no match on daemon 'no-such-daemon'/);
  });

  it("hide also accepts --daemon-host for the same disambiguation", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: ambiguousProjects });
    const code = await main(
      ["hide", "persona", "--daemon-host", "4090", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const call = backend.calls.find((c) => c.method === "patchProjectByQuery");
    assert.ok(call);
    assert.equal(call.projectId, "p1-4090");
  });

  it("passing an id with --daemon-host that disagrees → exit 2", async () => {
    // Guard against the operator passing both an id and a host that don't
    // line up. The CLI fails loudly so the user notices the inconsistency,
    // rather than silently honoring one and ignoring the other.
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({ projects: ambiguousProjects });
    const code = await main(
      ["set-default", "p1-4090", "--daemon-host", "m1", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 2);
    assert.match(stderr.collect(), /on daemon '4090', not 'm1'/);
  });
});

describe("conductor project set-default", () => {
  it("dry-run preview points at /api/projects/default with POST (review B3)", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [{ id: "p1", name: "alpha", isDefault: false, hidden: false }],
    });
    const code = await main(
      ["set-default", "p1", "--dry-run", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    assert.equal(data.request.method, "POST");
    assert.match(data.request.url, /\/api\/projects\/default$/);
    assert.equal(data.request.body.projectId, "p1");
    assert.equal(data.request.body.metadata.audit.actor, "cli");
  });

  it("live call returns the new default Project (SDK now returns Project, not void)", async () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const backend = new FakeBackendApi({
      projects: [{ id: "p1", name: "alpha", isDefault: false, hidden: false }],
    });
    const code = await main(
      ["set-default", "p1", "--json"],
      { stdout, stderr, ...makeCliDeps(backend) },
    );
    assert.equal(code, 0);
    const data = JSON.parse(stdout.collect().trim());
    // Earlier the SDK returned void → CLI printed `null`. Fix asserts a real
    // project object with the `isDefault` flag flipped.
    assert.equal(data.id, "p1");
    assert.equal(data.isDefault, true);
    const call = backend.calls.find((c) => c.method === "setDefaultProject");
    assert.ok(call);
    assert.equal(call.projectId, "p1");
    assert.equal(call.body.metadata.audit.actor, "cli");
  });
});
