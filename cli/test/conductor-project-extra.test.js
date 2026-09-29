import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main, parseInviteToken } from "../bin/conductor-project.js";
import { FakeBackendApi, makeCliDeps } from "./helpers/fake-backend.js";
import { runWithFetch } from "./helpers/fake-fetch.js";

const PROJECTS = [
  { id: "p1", name: "alpha", daemonHost: "m1", workspacePath: "/w/alpha", isDefault: true },
  { id: "p2", name: "beta", daemonHost: "m1", workspacePath: "/w/beta" },
  { id: "p3", name: "gamma", daemonHost: "m2", workspacePath: "/w/gamma" },
];

function sdkDeps(projects = PROJECTS) {
  return makeCliDeps(new FakeBackendApi({ projects }));
}

function run(args, routes = {}, projects = PROJECTS) {
  return runWithFetch(main, args, routes, sdkDeps(projects));
}

const notFound = () => ({ status: 404, body: { error: "Not found" } });

describe("conductor project update", () => {
  it("PATCHes name and mergeOptOut by projectId", async () => {
    const r = await run(["update", "beta", "--name", "beta2", "--merge-opt-out", "true"], {
      "PATCH /api/projects": (call) => ({ id: call.query.projectId, name: call.body.name }),
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].method, "PATCH");
    assert.deepEqual(r.calls[0].query, { projectId: "p2" });
    assert.deepEqual(r.calls[0].body, { name: "beta2", mergeOptOut: true });
    assert.match(r.out, /Updated project beta2 \(p2\)/);
  });

  it("sends a confirmed binding for --workspace-path and merges --json-body", async () => {
    const r = await run(
      ["update", "p2", "--workspace-path", "/x/y", "--bind-daemon-host", "m9", "--json-body", '{"hidden":false}', "--json"],
      { "PATCH /api/projects": (call) => ({ id: "p2", echo: call.body }) },
    );
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls[0].body, {
      daemonHost: "m9",
      workspacePath: "/x/y",
      bindingConfirmed: true,
      hidden: false,
    });
    assert.equal(JSON.parse(r.out).id, "p2");
  });

  it("--merge-opt-out false sends false", async () => {
    const r = await run(["update", "p2", "--merge-opt-out", "false"], {
      "PATCH /api/projects": () => ({ id: "p2", name: "beta" }),
    });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls[0].body, { mergeOptOut: false });
  });

  it("errors with ARGS when nothing to update", async () => {
    const r = await run(["update", "p2"]);
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
  });

  it("--dry-run makes no request", async () => {
    const r = await run(["update", "p2", "--name", "x", "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 0);
    const payload = JSON.parse(r.out);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.request.method, "PATCH");
    assert.equal(payload.request.url, "https://backend.example/api/projects?projectId=p2");
    assert.deepEqual(payload.request.body, { name: "x" });
  });

  it("maps a 404 to exit code 4", async () => {
    const r = await run(["update", "p2", "--name", "x"], { "PATCH /api/projects": notFound });
    assert.equal(r.code, 4);
    assert.match(r.err, /Not found/);
  });

  it("unknown project name exits 4 without a request", async () => {
    const r = await run(["update", "nope", "--name", "x"]);
    assert.equal(r.code, 4);
    assert.equal(r.calls.length, 0);
  });
});

describe("conductor project refresh", () => {
  it("PATCHes {refresh:true}", async () => {
    const r = await run(["refresh", "gamma"], {
      "PATCH /api/projects": () => ({ id: "p3", name: "gamma", worktreeBranch: "main", lastCommit: "abcdef1234567890" }),
    });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls[0].query, { projectId: "p3" });
    assert.deepEqual(r.calls[0].body, { refresh: true });
    assert.match(r.out, /Refreshed project gamma \(p3\) branch=main commit=abcdef123456/);
  });

  it("--json prints the raw response; --dry-run sends nothing", async () => {
    const routes = { "PATCH /api/projects": () => ({ id: "p3", fileCount: 7 }) };
    const r = await run(["refresh", "p3", "--json"], routes);
    assert.deepEqual(JSON.parse(r.out), { id: "p3", fileCount: 7 });
    const d = await run(["refresh", "p3", "--dry-run"], routes);
    assert.equal(d.code, 0);
    assert.equal(d.calls.length, 0);
    assert.match(d.out, /\[dry-run\] would send:\n {2}PATCH https:\/\/backend.example\/api\/projects\?projectId=p3/);
  });

  it("404 -> exit 4", async () => {
    const r = await run(["refresh", "p3"], { "PATCH /api/projects": notFound });
    assert.equal(r.code, 4);
  });
});

describe("conductor project delete", () => {
  it("requires --yes", async () => {
    const r = await run(["delete", "p2"]);
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.err, /--yes/);
  });

  it("DELETEs with --yes", async () => {
    const r = await run(["delete", "beta", "--yes"], {
      "DELETE /api/projects": () => ({ status: 204, body: undefined }),
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls[0].method, "DELETE");
    assert.deepEqual(r.calls[0].query, { projectId: "p2" });
    assert.equal(r.calls[0].body, undefined);
    assert.match(r.out, /Deleted project beta \(p2\)/);
  });

  it("--json output", async () => {
    const r = await run(["delete", "p2", "--yes", "--json"], {
      "DELETE /api/projects": () => ({ status: 204, body: undefined }),
    });
    assert.deepEqual(JSON.parse(r.out), { deleted: true, id: "p2" });
  });

  it("--dry-run works without --yes and sends nothing", async () => {
    const r = await run(["delete", "p2", "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 0);
    assert.equal(JSON.parse(r.out).request.method, "DELETE");
  });

  it("404 -> exit 4", async () => {
    const r = await run(["delete", "p2", "--yes"], { "DELETE /api/projects": notFound });
    assert.equal(r.code, 4);
  });
});

describe("conductor project reorder", () => {
  it("puts listed projects first and appends the rest", async () => {
    const r = await run(["reorder", "gamma", "beta"], {
      "POST /api/projects/reorder": (call) => ({ ok: true, projectIds: call.body.projectIds }),
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls[0].method, "POST");
    assert.deepEqual(r.calls[0].body, { projectIds: ["p3", "p2", "p1"] });
    assert.match(r.out, /Reordered 3 projects/);
  });

  it("--json prints the response, --dry-run sends nothing", async () => {
    const routes = { "POST /api/projects/reorder": (call) => ({ ok: true, projectIds: call.body.projectIds }) };
    const r = await run(["reorder", "p1", "--json"], routes);
    assert.deepEqual(JSON.parse(r.out).projectIds, ["p1", "p2", "p3"]);
    const d = await run(["reorder", "p1", "--dry-run", "--json"], routes);
    assert.equal(d.calls.length, 0);
    assert.deepEqual(JSON.parse(d.out).request.body, { projectIds: ["p1", "p2", "p3"] });
  });

  it("rejects duplicates", async () => {
    const r = await run(["reorder", "p1", "alpha"]);
    assert.equal(r.code, 2);
  });

  it("404 -> exit 4", async () => {
    const r = await run(["reorder", "p1"], { "POST /api/projects/reorder": notFound });
    assert.equal(r.code, 4);
  });
});

describe("conductor project agents", () => {
  const routes = {
    "GET /api/projects/p2/agents": () => ({
      agents: [{ name: "reviewer", description: "Reviews diffs", backend: "claude" }],
    }),
  };

  it("lists agents as a table", async () => {
    const r = await run(["agents", "beta"], routes);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls[0].method, "GET");
    assert.equal(r.calls[0].path, "/api/projects/p2/agents");
    assert.match(r.out, /NAME\s+BACKEND\s+DESCRIPTION/);
    assert.match(r.out, /reviewer\s+claude\s+Reviews diffs/);
  });

  it("--json prints the raw response and --project works", async () => {
    const r = await run(["agents", "--project", "p2", "--json"], routes);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).agents[0].name, "reviewer");
  });

  it("404 -> exit 4", async () => {
    const r = await run(["agents", "p3"], routes);
    assert.equal(r.code, 4);
  });
});

describe("conductor project collab", () => {
  const inviteResponse = {
    collaboration: { id: "c1", inviteUrl: "https://app.example/app/invite/tok123" },
    inviteToken: "tok123",
    inviteUrl: "https://app.example/app/invite/tok123",
  };

  it("invite POSTs and prints the link and token", async () => {
    const r = await run(["collab", "invite", "beta"], {
      "POST /api/projects/p2/collaboration": () => inviteResponse,
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls[0].method, "POST");
    assert.equal(r.calls[0].body, undefined);
    assert.match(r.out, /Collaboration c1 for project beta \(p2\)/);
    assert.match(r.out, /Invite URL: +https:\/\/app.example\/app\/invite\/tok123/);
    assert.match(r.out, /Invite token: tok123/);
  });

  it("invite --json / --dry-run / 404", async () => {
    const routes = { "POST /api/projects/p2/collaboration": () => inviteResponse };
    const j = await run(["collab", "invite", "p2", "--json"], routes);
    assert.equal(JSON.parse(j.out).inviteToken, "tok123");
    const d = await run(["collab", "invite", "p2", "--dry-run"], routes);
    assert.equal(d.calls.length, 0);
    assert.match(d.out, /POST https:\/\/backend.example\/api\/projects\/p2\/collaboration/);
    const n = await run(["collab", "invite", "p3"], routes);
    assert.equal(n.code, 4);
  });

  it("join with an invite URL into an existing project", async () => {
    const r = await run(["collab", "join", "https://app.example/app/invite/tok123", "--into", "gamma"], {
      "POST /api/collaboration/join": (call) => ({ collaborationId: "c1", projectId: call.body.projectId }),
    });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls[0].body, { inviteToken: "tok123", projectId: "p3" });
    assert.match(r.out, /Joined collaboration c1 with project p3/);
  });

  it("join --create-project sends createProjectName; --json", async () => {
    const r = await run(["collab", "join", "tok123", "--create-project", "shared", "--json"], {
      "POST /api/collaboration/join": () => ({ collaborationId: "c1", projectId: "pNew" }),
    });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls[0].body, { inviteToken: "tok123", createProjectName: "shared" });
    assert.equal(JSON.parse(r.out).projectId, "pNew");
  });

  it("join requires exactly one of --into / --create-project", async () => {
    const none = await run(["collab", "join", "tok"]);
    assert.equal(none.code, 2);
    const both = await run(["collab", "join", "tok", "--into", "p2", "--create-project", "x"]);
    assert.equal(both.code, 2);
    assert.equal(both.calls.length, 0);
  });

  it("join --dry-run and 404", async () => {
    const d = await run(["collab", "join", "tok", "--create-project", "x", "--dry-run", "--json"]);
    assert.equal(d.calls.length, 0);
    assert.equal(JSON.parse(d.out).request.url, "https://backend.example/api/collaboration/join");
    const n = await run(["collab", "join", "tok", "--create-project", "x"], {
      "POST /api/collaboration/join": () => ({ status: 404, body: { error: "Collaboration invite not found" } }),
    });
    assert.equal(n.code, 4);
    assert.match(n.err, /Collaboration invite not found/);
  });

  const listWithCollab = () => [
    { id: "p2", name: "beta", collaborationId: "c 1" },
    { id: "p3", name: "gamma", collaborationId: null },
  ];

  it("leave looks up the collaboration id and DELETEs members/me", async () => {
    const r = await run(["collab", "leave", "beta"], {
      "GET /api/projects": listWithCollab,
      "DELETE /api/collaboration/c%201/members/me": () => ({ status: 204, body: undefined }),
    });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [
      "GET /api/projects",
      "DELETE /api/collaboration/c%201/members/me",
    ]);
    assert.match(r.out, /Left collaboration c 1/);
  });

  it("leave errors when the project is not collaborating", async () => {
    const r = await run(["collab", "leave", "gamma"], { "GET /api/projects": listWithCollab });
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 1);
  });

  it("leave --json, --dry-run, 404", async () => {
    const routes = {
      "GET /api/projects": listWithCollab,
      "DELETE /api/collaboration/c%201/members/me": () => ({ status: 204, body: undefined }),
    };
    const j = await run(["collab", "leave", "p2", "--json"], routes);
    assert.deepEqual(JSON.parse(j.out), { left: true, collaborationId: "c 1", projectId: "p2" });
    const d = await run(["collab", "leave", "p2", "--dry-run"], routes);
    assert.equal(d.calls.filter((c) => c.method === "DELETE").length, 0);
    const n = await run(["collab", "leave", "p2"], {
      "GET /api/projects": listWithCollab,
      "DELETE /api/collaboration/c%201/members/me": () => ({
        status: 404, body: { error: "Collaboration membership not found" },
      }),
    });
    assert.equal(n.code, 4);
  });

  it("parseInviteToken handles tokens and URLs", () => {
    assert.equal(parseInviteToken("abc"), "abc");
    assert.equal(parseInviteToken("https://x.test/app/invite/a%2Bb"), "a+b");
    assert.throws(() => parseInviteToken("https://x.test/other"), /invite token/);
  });
});

describe("conductor project collab show-invite", () => {
  it("previews an invite URL and lists joinable projects", async () => {
    const r = await run(["collab", "show-invite", "https://app.example/app/invite/tok9"], {
      "GET /api/invitations/tok9": {
        collaboration: { id: "c1", members: [{ userId: "u1" }, { userId: "u2" }] },
        candidateProjects: [
          { id: "p2", name: "beta", daemonHost: "m1", canJoin: true },
          { id: "p3", name: "gamma", daemonHost: "m2", canJoin: false },
        ],
        alreadyJoined: false,
        isFull: false,
        suggestedProjectName: "shared",
      },
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Collaboration c1 \(2 members\)/);
    assert.match(r.out, /p2  beta@m1/);
    assert.equal(r.out.includes("gamma"), false);
    assert.match(r.out, /collab join tok9/);
  });

  it("maps an unknown invite to exit 4", async () => {
    const r = await run(["collab", "show-invite", "nope"], { "GET /api/invitations/nope": notFound });
    assert.equal(r.code, 4);
  });
});

describe("conductor project labels", () => {
  const merged = [
    { id: "p1", name: "alpha", daemonHost: "m1", workspacePath: "/w/a" },
    { id: "p4", name: "repo", daemonHost: "m1", workspacePath: "/w/r", mergeOptOut: false },
  ];
  const rawProjects = () => [
    {
      id: "p4", name: "repo", daemonHost: "m1", gitRemoteUrl: "github.com/o/r",
      metadata: { memos: ["keep"], taskLabels: [{ id: "l1", name: "bug" }] },
    },
    {
      id: "p5", name: "repo", daemonHost: "m2", gitRemoteUrl: "github-work/o/r",
      metadata: { taskLabels: [{ id: "l2", name: "ui" }] },
    },
    { id: "p6", name: "repo", daemonHost: "m3", mergeOptOut: true, metadata: { taskLabels: [{ id: "l9", name: "x" }] } },
    { id: "p1", name: "alpha", daemonHost: "m1", metadata: null },
  ];

  it("list unions labels across the merged group", async () => {
    const r = await run(["labels", "list", "repo", "--json"], { "GET /api/projects": rawProjects }, merged);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), [{ id: "l1", name: "bug" }, { id: "l2", name: "ui" }]);
  });

  it("list human output and empty state", async () => {
    const r = await run(["labels", "list", "--project", "p4"], { "GET /api/projects": rawProjects }, merged);
    assert.match(r.out, /l1\s+bug/);
    const e = await run(["labels", "list", "alpha"], { "GET /api/projects": rawProjects }, merged);
    assert.match(e.out, /\(no labels\)/);
  });

  it("add fans out to every member, preserving other metadata keys", async () => {
    const r = await run(["labels", "add", "  needs   review ", "--project", "repo"], {
      "GET /api/projects": rawProjects,
      "PATCH /api/projects": (call) => ({ id: call.query.projectId }),
    }, merged);
    assert.equal(r.code, 0, r.err);
    const patches = r.calls.filter((c) => c.method === "PATCH");
    assert.deepEqual(patches.map((c) => c.query.projectId), ["p4", "p5"]);
    const labels = patches[0].body.metadata.taskLabels;
    assert.deepEqual(labels.map((l) => l.name), ["bug", "ui", "needs review"]);
    assert.deepEqual(patches[0].body.metadata.memos, ["keep"]);
    assert.deepEqual(patches[1].body.metadata.taskLabels, labels);
    assert.match(r.out, /Added label needs review/);
  });

  it("add rejects duplicate names (case-insensitive)", async () => {
    const r = await run(["labels", "add", "BUG", "--project", "p4"], { "GET /api/projects": rawProjects }, merged);
    assert.equal(r.code, 2);
    assert.equal(r.calls.filter((c) => c.method === "PATCH").length, 0);
  });

  it("rename and remove by name or id", async () => {
    const routes = {
      "GET /api/projects": rawProjects,
      "PATCH /api/projects": (call) => ({ id: call.query.projectId }),
    };
    const rn = await run(["labels", "rename", "bug", "defect", "--project", "p4", "--json"], routes, merged);
    assert.equal(rn.code, 0, rn.err);
    assert.deepEqual(JSON.parse(rn.out), { id: "l1", name: "defect" });
    const rm = await run(["labels", "remove", "l2", "--project", "p4"], routes, merged);
    assert.equal(rm.code, 0, rm.err);
    const patch = rm.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch.body.metadata.taskLabels, [{ id: "l1", name: "bug" }]);
    assert.match(rm.out, /Removed label ui \(l2\)/);
  });

  it("--dry-run previews every member PATCH without sending", async () => {
    const r = await run(["labels", "remove", "ui", "--project", "p4", "--dry-run"], {
      "GET /api/projects": rawProjects,
    }, merged);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.filter((c) => c.method === "PATCH").length, 0);
    assert.equal((r.out.match(/\[dry-run\]/g) || []).length, 2);
  });

  it("unknown label -> exit 4; PATCH 404 -> exit 4", async () => {
    const u = await run(["labels", "remove", "nope", "--project", "p4"], { "GET /api/projects": rawProjects }, merged);
    assert.equal(u.code, 4);
    const n = await run(["labels", "add", "new", "--project", "p4"], {
      "GET /api/projects": rawProjects,
      "PATCH /api/projects": notFound,
    }, merged);
    assert.equal(n.code, 4);
  });
});
