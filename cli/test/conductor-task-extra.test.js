import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../bin/conductor-task.js";
import { FakeBackendApi, makeCliDeps } from "./helpers/fake-backend.js";
import { runWithFetch } from "./helpers/fake-fetch.js";
import { BackendApiError } from "../../modules/conductor-sdk/dist/index.js";

const seedProject = { id: "proj-1", name: "alpha", workspacePath: "/tmp/alpha", isDefault: true };
const otherProject = { id: "proj-2", name: "beta", workspacePath: "/tmp/beta", isDefault: false };

function sdkDeps(initial = {}) {
  const backend = new FakeBackendApi({ projects: [seedProject, otherProject], ...initial });
  const deps = makeCliDeps(backend);
  // Keep the fetch-side test env/config from runWithFetch.
  delete deps.env;
  delete deps.cwd;
  return { backend, deps };
}

describe("conductor task lifecycle verbs", () => {
  it("stop PATCHes status=killed", async () => {
    const { code, out, calls } = await runWithFetch(main, ["stop", "t1"], {
      "PATCH /api/tasks/t1": ({ body }) => ({ id: "t1", status: body.status, title: "Fix" }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { status: "killed" });
    assert.match(out, /Stopped task t1 \[killed\] Fix/);
  });

  it("interrupt defaults target_reply_to to the latest user message", async () => {
    const { deps } = sdkDeps({
      messages: [
        { id: "m1", taskId: "t1", role: "user", content: "a", createdAt: "2026-01-01T00:00:00Z" },
        { id: "m2", taskId: "t1", role: "assistant", content: "b", createdAt: "2026-01-01T00:00:01Z" },
        { id: "m3", taskId: "t1", role: "user", content: "c", createdAt: "2026-01-01T00:00:02Z" },
      ],
      tasks: [{ id: "t1", projectId: "proj-1", title: "x", status: "running" }],
    });
    const { code, err, calls } = await runWithFetch(main, ["interrupt", "t1", "--json"], {
      "POST /api/tasks/t1/interrupt": ({ body }) => ({ delivered: true, target_reply_to: body.target_reply_to }),
    }, deps);
    assert.equal(code, 0, err);
    assert.deepEqual(calls[0].body, { target_reply_to: "m3" });
  });

  it("interrupt honours --target-reply-to without reading messages", async () => {
    const { code, calls } = await runWithFetch(main, ["interrupt", "t1", "--target-reply-to", "m9"], {
      "POST /api/tasks/t1/interrupt": { delivered: true },
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { target_reply_to: "m9" });
  });

  it("restart maps flags onto the route's snake_case body", async () => {
    const { code, out, calls } = await runWithFetch(
      main,
      ["restart", "t1", "--strategy", "new_task", "--backend", "codex", "--daemon-host", "l20", "--first-message", "continue"],
      { "POST /api/tasks/t1/restart": { mode: "new_task", task: { id: "t2", status: "init", title: "Fix" } } },
    );
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { strategy: "new_task", backend_type: "codex", agent_host: "l20", first_message: "continue" });
    assert.match(out, /as new task t2/);
  });

  it("restart --refresh-session sends restart_mode", async () => {
    const { code, calls } = await runWithFetch(main, ["restart", "t1", "--refresh-session"], {
      "POST /api/tasks/t1/restart": { mode: "inplace", task: { id: "t1" } },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { restart_mode: "refresh_session" });
  });

  it("restart --first-message without new_task is an args error", async () => {
    const { code, calls } = await runWithFetch(main, ["restart", "t1", "--first-message", "hi"], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });

  it("delete requires --yes, and --permanent adds the query flag", async () => {
    const refused = await runWithFetch(main, ["delete", "t1"], {});
    assert.equal(refused.code, 2);
    assert.equal(refused.calls.length, 0);
    assert.match(refused.err, /--yes/);

    const { code, calls } = await runWithFetch(main, ["delete", "t1", "--yes", "--permanent"], {
      "DELETE /api/tasks/t1": { success: true },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { permanent: "1" });
  });

  it("delete --dry-run previews without --yes and sends nothing", async () => {
    const { code, out, calls } = await runWithFetch(main, ["delete", "t1", "--dry-run", "--json"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.equal(JSON.parse(out).request.method, "DELETE");
  });

  it("archive POSTs achieve", async () => {
    const { code, calls } = await runWithFetch(main, ["archive", "t1"], {
      "POST /api/tasks/t1/achieve": { id: "t1", achievedAt: "2026-01-01T00:00:00Z" },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].path, "/api/tasks/t1/achieve");
  });

  it("unarchive asks for a plan then restarts with it", async () => {
    const { code, out, calls } = await runWithFetch(main, ["unarchive", "t1", "--daemon-host", "l20"], {
      "POST /api/tasks/t1/unachieve": { strategy: "new_task", agentHost: "l20", taskId: "t1" },
      "POST /api/tasks/t1/restart": { mode: "new_task", task: { id: "t9", title: "Fix" } },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { agent_host: "l20" });
    assert.deepEqual(calls[1].body, { strategy: "new_task", agent_host: "l20" });
    assert.match(out, /as new task t9/);
  });

  it("unarchive surfaces daemon candidates on 409 daemon_offline", async () => {
    const { code, err, calls } = await runWithFetch(main, ["unarchive", "t1"], {
      "POST /api/tasks/t1/unachieve": {
        status: 409,
        body: { code: "daemon_offline", error: "Original daemon mac is offline.", candidates: ["l20", "box"] },
      },
    });
    assert.equal(code, 1);
    assert.equal(calls.length, 1);
    assert.match(err, /--daemon-host <l20\|box>/);
  });

  it("unarchive --backend lets restart pick the strategy when the plan is inplace", async () => {
    const { code, err, calls } = await runWithFetch(main, ["unarchive", "t1", "--backend", "codex"], {
      "POST /api/tasks/t1/unachieve": { strategy: "inplace", agentHost: "mac", taskId: "t1" },
      "POST /api/tasks/t1/restart": { mode: "new_task", task: { id: "t9", title: "Fix" } },
    });
    assert.equal(code, 0, err);
    // An explicit "inplace" + a different backend is a 409 at /restart.
    assert.deepEqual(calls[1].body, { agent_host: "mac", backend_type: "codex" });
  });

  it("unarchive --backend keeps a new_task plan", async () => {
    const { code, err, calls } = await runWithFetch(main, ["unarchive", "t1", "--daemon-host", "l20", "--backend", "codex"], {
      "POST /api/tasks/t1/unachieve": { strategy: "new_task", agentHost: "l20", taskId: "t1" },
      "POST /api/tasks/t1/restart": { mode: "new_task", task: { id: "t9", title: "Fix" } },
    });
    assert.equal(code, 0, err);
    assert.deepEqual(calls[1].body, { strategy: "new_task", agent_host: "l20", backend_type: "codex" });
  });

  it("unarchive without --backend passes the inplace plan through", async () => {
    const { code, err, calls } = await runWithFetch(main, ["unarchive", "t1"], {
      "POST /api/tasks/t1/unachieve": { strategy: "inplace", agentHost: "mac", taskId: "t1" },
      "POST /api/tasks/t1/restart": { mode: "inplace_restart", task: { id: "t1", title: "Fix" } },
    });
    assert.equal(code, 0, err);
    assert.deepEqual(calls[1].body, { strategy: "inplace", agent_host: "mac" });
  });

  it("returns exit 4 when the task does not exist", async () => {
    const { code, err } = await runWithFetch(main, ["stop", "nope"], {
      "PATCH /api/tasks/nope": { status: 404, body: { error: "Not found" } },
    });
    assert.equal(code, 4);
    assert.match(err, /Not found/);
  });
});

describe("conductor task attribute verbs", () => {
  it("rename, pin and unpin PATCH the task", async () => {
    const routes = { "PATCH /api/tasks/t1": ({ body }) => ({ id: "t1", ...body }) };
    const rename = await runWithFetch(main, ["rename", "t1", "New title"], routes);
    assert.deepEqual(rename.calls[0].body, { title: "New title" });
    const pin = await runWithFetch(main, ["pin", "t1"], routes);
    assert.match(pin.calls[0].body.metadata.pinnedAt, /^\d{4}-/);
    const unpin = await runWithFetch(main, ["unpin", "t1"], routes);
    assert.deepEqual(unpin.calls[0].body, { metadata: { pinnedAt: null } });
  });

  it("move resolves the target project by name; --back clears it", async () => {
    const { deps } = sdkDeps();
    const routes = { "PUT /api/tasks/t1/second-project": ({ body }) => ({ id: "t1", second_project_id: body.second_project_id }) };
    const moved = await runWithFetch(main, ["move", "t1", "beta"], routes, deps);
    assert.equal(moved.code, 0, moved.err);
    assert.deepEqual(moved.calls[0].body, { second_project_id: "proj-2" });
    const back = await runWithFetch(main, ["move", "t1", "--back"], routes);
    assert.deepEqual(back.calls[0].body, { second_project_id: null });
  });

  it("labels replaces the label set, --clear sends []", async () => {
    const routes = { "PUT /api/tasks/t1/labels": { id: "t1" } };
    const set = await runWithFetch(main, ["labels", "t1", "l1", "l2"], routes);
    assert.deepEqual(set.calls[0].body, { label_ids: ["l1", "l2"] });
    const clear = await runWithFetch(main, ["labels", "t1", "--clear"], routes);
    assert.deepEqual(clear.calls[0].body, { label_ids: [] });
    const none = await runWithFetch(main, ["labels", "t1"], routes);
    assert.equal(none.code, 2);
  });

  it("share prints the public link; unshare DELETEs it", async () => {
    const shared = await runWithFetch(main, ["share", "t1"], {
      "POST /api/tasks/t1/share": { token: "tok123", createdAt: "x" },
    });
    assert.match(shared.out, /https:\/\/backend\.example\/share\/tok123/);
    const unshared = await runWithFetch(main, ["unshare", "t1"], { "DELETE /api/tasks/t1/share": { success: true } });
    assert.equal(unshared.code, 0);
    assert.equal(unshared.calls[0].method, "DELETE");
  });
});

describe("conductor task persistent / rounds / worktree / terminal", () => {
  it("persistent sends only the given settings", async () => {
    const { calls } = await runWithFetch(main, ["persistent", "t1", "--enable", "--instructions", "keep going"], {
      "PATCH /api/tasks/t1/persistent": { id: "t1" },
    });
    assert.deepEqual(calls[0].body, { enabled: true, instructions: "keep going" });
    const empty = await runWithFetch(main, ["persistent", "t1"], {});
    assert.equal(empty.code, 2);
  });

  it("round end / round start", async () => {
    const end = await runWithFetch(main, ["round", "end", "t1"], { "POST /api/tasks/t1/rounds/end": { id: "t1" } });
    assert.equal(end.code, 0);
    const start = await runWithFetch(
      main,
      ["round", "start", "t1", "next step", "--backend", "claude", "--worktree", "new", "--expected-round", "3"],
      { "POST /api/tasks/t1/rounds": { id: "t1" } },
    );
    assert.equal(start.code, 0, start.err);
    assert.deepEqual(start.calls[0].body, { content: "next step", backend_type: "claude", worktree: "new", expected_round: 3 });
  });

  it("round start pins the task's current round by default, like the web composer", async () => {
    const { code, err, calls } = await runWithFetch(main, ["round", "start", "t1", "next"], {
      "GET /api/tasks/t1": { id: "t1", metadata: { persistent: { enabled: true, round: 4 } } },
      "POST /api/tasks/t1/rounds": { id: "t1" },
    });
    assert.equal(code, 0, err);
    assert.equal(calls[0].method, "GET");
    assert.deepEqual(calls[1].body, { content: "next", expected_round: 4 });
  });

  it("cleanup-worktree POSTs the worktree route", async () => {
    const { code, out } = await runWithFetch(main, ["cleanup-worktree", "t1"], {
      "POST /api/tasks/t1/worktree": { task: { id: "t1" }, cleaned_at: "x", removed_path: "/w/t1" },
    });
    assert.equal(code, 0);
    assert.match(out, /\/w\/t1/);
  });

  it("terminal open / show / close", async () => {
    const routes = {
      "POST /api/tasks/t1/terminal": { id: "a1", pty_task_id: "p1" },
      "GET /api/tasks/t1/terminal": { id: "a1", pty_task_id: "p1", pty_task: { id: "p1", status: "running", title: "Terminal" } },
      "DELETE /api/tasks/t1/terminal": { success: true },
    };
    assert.match((await runWithFetch(main, ["terminal", "open", "t1"], routes)).out, /PTY task p1/);
    assert.match((await runWithFetch(main, ["terminal", "show", "t1"], routes)).out, /p1 \[running\]/);
    const closed = await runWithFetch(main, ["terminal", "close", "t1"], routes);
    assert.equal(closed.calls[0].method, "DELETE");
  });
});

describe("conductor task create / resume / list extensions", () => {
  it("create with agent group, worktree, and persistent posts the frontend payload", async () => {
    const { deps } = sdkDeps();
    const { code, err, out, calls } = await runWithFetch(
      main,
      ["create", "--title", "Build", "--prompt", "go", "--daemon-host", "mac", "--backend", "claude",
        "--agent", "feature-dev", "--agent", "code-reviewer:codex", "--worktree", "--persistent"],
      { "POST /api/tasks": ({ body }) => ({ id: "t5", title: body.title, reviewer_task_ids: ["t6"] }) },
      deps,
    );
    assert.equal(code, 0, err);
    const body = calls[0].body;
    assert.equal(body.projectId, "proj-1");
    assert.equal(body.agentHost, "mac");
    assert.equal(body.backendType, "claude");
    assert.equal(body.initialContent, "go");
    assert.deepEqual(body.agents, [{ name: "feature-dev" }, { name: "code-reviewer", backend: "codex" }]);
    assert.deepEqual(body.launchConfig, { worktree: true });
    assert.deepEqual(body.metadata.persistent, { enabled: true });
    assert.equal(body.metadata.audit.actor, "cli");
    assert.match(out, /Reviewer tasks: t6/);
  });

  it("create --global-backend and --worktree", async () => {
    const { deps } = sdkDeps();
    const { code, err, calls } = await runWithFetch(
      main,
      ["create", "--title", "G", "--global-backend", "l20:claude", "--worktree"],
      { "POST /api/tasks": { id: "t7", title: "G" } },
      deps,
    );
    assert.equal(code, 0, err);
    assert.deepEqual(calls[0].body.globalBackend, { host: "l20", backend: "claude" });
    assert.equal(calls[0].body.backendType, "claude");
    assert.deepEqual(calls[0].body.launchConfig, { worktree: true });
  });

  it("create rejects --global-backend with --remote-worktree (server 409s it)", async () => {
    const { deps } = sdkDeps();
    const { code, err, calls } = await runWithFetch(
      main,
      ["create", "--title", "G", "--global-backend", "l20:claude", "--remote-worktree", "ubuntu"],
      {},
      deps,
    );
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.match(err, /--remote-worktree/);
  });

  it("create rejects a --backend that differs from --global-backend", async () => {
    const { deps } = sdkDeps();
    const { code, err, calls } = await runWithFetch(
      main,
      ["create", "--title", "G", "--global-backend", "l20:claude", "--backend", "codex"],
      {},
      deps,
    );
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.match(err, /does not match/);
  });

  it("create accepts a --backend equal to the --global-backend backend", async () => {
    const { deps } = sdkDeps();
    const { code, err, calls } = await runWithFetch(
      main,
      ["create", "--title", "G", "--global-backend", "l20:claude", "--backend", "claude"],
      { "POST /api/tasks": { id: "t7", title: "G" } },
      deps,
    );
    assert.equal(code, 0, err);
    assert.equal(calls[0].body.backendType, "claude");
  });

  it("create with new flags still warns when the parent grouping failed", async () => {
    const { deps } = sdkDeps();
    const { code, out, err } = await runWithFetch(
      main,
      ["create", "--title", "G", "--worktree", "--parent-task-id", "tp"],
      {
        "POST /api/tasks": {
          id: "t8",
          title: "G",
          grouping: { parent_task_id: "tp", grouped: false, warning: "Task was created, but parent task grouping could not be saved" },
        },
      },
      deps,
    );
    assert.equal(code, 0, err);
    assert.match(out, /Created app task t8/);
    assert.match(err, /Warning: Task was created, but parent task grouping could not be saved/);
  });

  it("create rejects --global-backend with --agent", async () => {
    const { deps } = sdkDeps();
    const { code, calls } = await runWithFetch(
      main,
      ["create", "--title", "G", "--global-backend", "l20:claude", "--agent", "x"],
      {},
      deps,
    );
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });

  it("resume creates a task bound to the existing session, in the session's project", async () => {
    const { deps } = sdkDeps();
    const { code, err, calls } = await runWithFetch(
      main,
      ["resume", "--daemon-host", "mac", "--backend", "codex", "--session", "abcdef123456", "--session-file", "/s.jsonl"],
      {
        "GET /api/agents/mac/sessions": { sessions: [{ backend: "codex", session_id: "abcdef123456", project_id: "proj-2" }] },
        "POST /api/tasks": ({ body }) => ({ id: "t8", title: body.title }),
      },
      deps,
    );
    assert.equal(code, 0, err);
    assert.deepEqual(calls[0].query, { backends: "codex", limit: "200" });
    const post = calls[1].body;
    assert.equal(post.projectId, "proj-2");
    assert.equal(post.sessionId, "abcdef123456");
    assert.equal(post.sessionFilePath, "/s.jsonl");
    assert.equal(post.agentHost, "mac");
    assert.equal(post.title, "Resume codex abcdef12");
  });

  it("resume falls back to the default project when the session cwd matches none", async () => {
    const { deps } = sdkDeps();
    const { code, err, calls } = await runWithFetch(
      main,
      ["resume", "--daemon-host", "mac", "--backend", "codex", "--session", "s1"],
      {
        "GET /api/agents/mac/sessions": { sessions: [{ backend: "codex", session_id: "s1", project_id: null }] },
        "POST /api/tasks": { id: "t8" },
      },
      deps,
    );
    assert.equal(code, 0, err);
    assert.equal(calls[1].body.projectId, "proj-1");
  });

  const cwdProject = { id: "proj-cwd", name: "cwd", workspacePath: "/tmp/cli-test", isDefault: false };

  for (const [label, sessionsRoute, reason] of [
    ["the daemon cannot list sessions (older daemon)",
      { status: 409, body: { error: "daemon_capability_missing" } }, /could not list sessions on mac/],
    ["the daemon is offline", { status: 404, body: { error: "daemon_offline" } }, /could not list sessions on mac/],
    ["the session is not in the list",
      { sessions: [{ backend: "codex", session_id: "other", project_id: "proj-2" }] }, /session s1 is not among the codex sessions listed on mac/],
  ]) {
    it(`resume falls back to the cwd project with a warning when ${label}`, async () => {
      const { deps } = sdkDeps({ projects: [seedProject, otherProject, cwdProject] });
      const { code, err, calls } = await runWithFetch(
        main,
        ["resume", "--daemon-host", "mac", "--backend", "codex", "--session", "s1"],
        { "GET /api/agents/mac/sessions": sessionsRoute, "POST /api/tasks": { id: "t8" } },
        deps,
      );
      assert.equal(code, 0, err);
      assert.equal(calls.at(-1).body.projectId, "proj-cwd");
      assert.match(err, reason);
      assert.match(err, /using the project from the current directory/);
    });
  }

  it("resume --project skips the session lookup", async () => {
    const { deps } = sdkDeps();
    const { code, err, calls } = await runWithFetch(
      main,
      ["resume", "--daemon-host", "mac", "--backend", "codex", "--session", "s1", "--project", "proj-2"],
      { "POST /api/tasks": { id: "t8" } },
      deps,
    );
    assert.equal(code, 0, err);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.projectId, "proj-2");
  });

  it("resume points at the linked task instead of creating a duplicate", async () => {
    const { deps } = sdkDeps();
    const { code, err, out } = await runWithFetch(
      main,
      ["resume", "--daemon-host", "mac", "--backend", "codex", "--session", "s1", "--project", "proj-1"],
      { "POST /api/tasks": { status: 409, body: { error: "session_already_linked", task_id: "t-old" } } },
      deps,
    );
    assert.equal(code, 0, err);
    assert.match(out, /already linked to task t-old/);
  });

  it("list --project-ids merges projects and filters status client-side", async () => {
    const { code, out, calls } = await runWithFetch(main, ["list", "--project-ids", "p1,p2", "--status", "running"], {
      "GET /api/tasks": [
        { id: "t1", status: "running", title: "A", project_id: "p1" },
        { id: "t2", status: "completed", title: "B", project_id: "p2" },
      ],
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { project_ids: "p1,p2" });
    assert.match(out, /t1/);
    assert.equal(out.includes("t2"), false);
  });

  it("list --all-projects lists everything without a project filter", async () => {
    const { code, calls } = await runWithFetch(main, ["list", "--all-projects", "--json"], { "GET /api/tasks": [] });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, {});
  });
});

describe("conductor task attachment download", () => {
  it("saves the file under the server-supplied name, confined to the target dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-dl-"));
    const { code, err, calls } = await runWithFetch(main, ["attachment", "download", "t1", "a1", "-o", dir], {
      "GET /api/tasks/t1/attachments/a1": {
        status: 200,
        body: Buffer.from("hello-bytes"),
        headers: { "content-disposition": "attachment; filename=\"../../evil.txt\"" },
      },
    });
    assert.equal(code, 0, err);
    assert.equal(calls[0].method, "GET");
    assert.equal(fs.readFileSync(path.join(dir, "evil.txt"), "utf8"), "hello-bytes");
  });

  it("-o - writes the bytes to stdout", async () => {
    const { code, out } = await runWithFetch(main, ["attachment", "download", "t1", "a1", "-o", "-"], {
      "GET /api/tasks/t1/attachments/a1": { status: 200, body: Buffer.from("raw"), headers: {} },
    });
    assert.equal(code, 0);
    assert.equal(out, "raw");
  });

  it("maps a missing attachment to exit 4", async () => {
    const { code } = await runWithFetch(main, ["attachment", "download", "t1", "nope", "-o", "-"], {
      "GET /api/tasks/t1/attachments/nope": { status: 404, body: { error: "Not found" } },
    });
    assert.equal(code, 4);
  });
});

describe("conductor task send --attach / messages --follow / schedule update", () => {
  it("uploads attachments then binds them to the message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-attach-"));
    const file = path.join(dir, "shot.png");
    fs.writeFileSync(file, "png-bytes");
    const { code, err, calls } = await runWithFetch(main, ["send", "t1", "see this", "--attach", file], {
      "POST /api/tasks/t1/attachments": { attachment: { id: "att-1", name: "shot.png" } },
      "POST /api/tasks/t1/messages": ({ body }) => ({ id: "m1", ...body }),
    });
    assert.equal(code, 0, err);
    assert.ok(calls[0].body instanceof FormData);
    assert.equal(calls[0].body.get("file").name, "shot.png");
    assert.deepEqual(calls[1].body.attachmentIds, ["att-1"]);
    assert.equal(calls[1].body.content, "see this");
    assert.equal(calls[1].body.role, "user");
    assert.equal(calls[1].body.metadata.audit.actor, "cli");
  });

  it("send --attach retries while the task's fire owner has not bound yet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-attach-"));
    const file = path.join(dir, "shot.png");
    fs.writeFileSync(file, "png-bytes");
    let posts = 0;
    const sleeps = [];
    const { code, err } = await runWithFetch(main, ["send", "t1", "see this", "--attach", file], {
      "POST /api/tasks/t1/attachments": { attachment: { id: "att-1", name: "shot.png" } },
      "POST /api/tasks/t1/messages": ({ body }) => (++posts === 1
        ? { status: 409, body: { code: "task_missing_active_fire_owner", error: "Task missing active fire owner" } }
        : { id: "m1", ...body }),
    }, { sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(code, 0, err);
    assert.equal(posts, 2);
    assert.deepEqual(sleeps, [500]);
  });

  it("send retries while the task's fire owner has not bound yet, but not other conflicts", async () => {
    const { backend, deps } = sdkDeps({ tasks: [{ id: "t1", projectId: "proj-1", title: "x", status: "running" }] });
    const original = backend.postTaskMessage.bind(backend);
    const failures = [
      new BackendApiError("conflict", 409, { code: "task_missing_active_fire_owner" }),
    ];
    backend.postTaskMessage = async (taskId, body) => {
      const failure = failures.shift();
      if (failure) {
        backend.calls.push({ method: "postTaskMessage", taskId, body });
        throw failure;
      }
      return original(taskId, body);
    };
    const sleep = async () => {};
    const ok = await runWithFetch(main, ["send", "t1", "hi"], {}, { ...deps, sleep });
    assert.equal(ok.code, 0, ok.err);
    assert.equal(backend.calls.filter((call) => call.method === "postTaskMessage").length, 2);

    failures.push(new BackendApiError("conflict", 409, { error: "task_not_running" }));
    const rejected = await runWithFetch(main, ["send", "t1", "hi"], {}, { ...deps, sleep });
    assert.notEqual(rejected.code, 0);
    assert.equal(backend.calls.filter((call) => call.method === "postTaskMessage").length, 3);
  });

  it("send --attach with a missing file is an args error", async () => {
    const { code, calls } = await runWithFetch(main, ["send", "t1", "x", "--attach", "/no/such/file"], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });

  it("messages --follow prints each message once", async () => {
    const { backend, deps } = sdkDeps({
      messages: [{ id: "m1", taskId: "t1", role: "user", content: "hi" }],
      tasks: [{ id: "t1", projectId: "proj-1", title: "x", status: "running" }],
    });
    let polls = 0;
    const { code, out, err } = await runWithFetch(main, ["messages", "t1", "--follow"], {}, {
      ...deps,
      maxFollowPolls: 2,
      sleep: async () => {
        polls += 1;
        if (polls === 1) backend.messages.push({ id: "m2", taskId: "t1", role: "assistant", content: "hello" });
      },
    });
    assert.equal(code, 0, err);
    assert.equal(out, "[user] hi\n[assistant] hello\n");
  });

  it("messages --follow pages back so a burst of more than 50 is not dropped", async () => {
    const { backend, deps } = sdkDeps({
      messages: [{ id: "m000", taskId: "t1", role: "user", content: "start" }],
      tasks: [{ id: "t1", projectId: "proj-1", title: "x", status: "running" }],
    });
    // Same paging as GET /api/tasks/:id/messages: newest `limit`, oldest first, `before` exclusive.
    backend.listTaskMessages = async (taskId, params = {}) => {
      let list = backend.messages.filter((m) => m.taskId === taskId);
      if (params.before) list = list.slice(0, list.findIndex((m) => m.id === params.before));
      return list.slice(-(params.limit ?? 50)).map((m) => ({ ...m }));
    };
    let polls = 0;
    const { code, out, err } = await runWithFetch(main, ["messages", "t1", "--follow"], {}, {
      ...deps,
      maxFollowPolls: 1,
      sleep: async () => {
        polls += 1;
        for (let i = 1; i <= 120; i += 1) {
          backend.messages.push({ id: `m${String(i).padStart(3, "0")}`, taskId: "t1", role: "assistant", content: `n${i}` });
        }
      },
    });
    assert.equal(code, 0, err);
    const lines = out.trim().split("\n");
    assert.equal(lines.length, 121);
    assert.equal(lines[0], "[user] start");
    assert.equal(lines[1], "[assistant] n1");
    assert.equal(lines[120], "[assistant] n120");
  });

  it("shared reads a share link by token", async () => {
    const { code, out, err, calls } = await runWithFetch(main, ["shared", "https://backend.example/share/tok%2B1"], {
      "GET /api/shared/tok%2B1": {
        task: { id: "t1", title: "Fix", status: "completed", expiresAt: null },
        messages: [{ id: "m1", role: "user", content: "hi" }, { id: "m2", role: "assistant", content: "done" }],
      },
    });
    assert.equal(code, 0, err);
    assert.equal(calls[0].method, "GET");
    assert.equal(out, "Fix [completed]\n[user] hi\n[assistant] done\n");
  });

  it("shared surfaces 410 for an expired link", async () => {
    const { code, err } = await runWithFetch(main, ["shared", "old"], {
      "GET /api/shared/old": { status: 410, body: { error: "This shared link has expired" } },
    });
    assert.notEqual(code, 0);
    assert.match(err, /expired/);
  });

  it("transcribe uploads the audio as multipart `file` with the language", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-speech-"));
    const file = path.join(dir, "note.wav");
    fs.writeFileSync(file, "RIFF-bytes");
    const { code, out, err, calls } = await runWithFetch(main, ["transcribe", file, "--language", "zh"], {
      "POST /api/speech/transcribe": { text: "你好" },
    });
    assert.equal(code, 0, err);
    assert.ok(calls[0].body instanceof FormData);
    assert.equal(calls[0].body.get("file").name, "note.wav");
    assert.equal(calls[0].body.get("file").type, "audio/wav");
    assert.equal(calls[0].body.get("language"), "zh");
    assert.equal(out, "你好\n");
  });

  it("transcribe rejects unsupported audio before uploading", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-speech-"));
    const file = path.join(dir, "note.ogg");
    fs.writeFileSync(file, "x");
    const { code, calls } = await runWithFetch(main, ["transcribe", file], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });

  it("schedule update PATCHes content and schedule", async () => {
    const { code, err, calls } = await runWithFetch(main, ["schedule", "update", "t1", "s1", "new text", "--delay", "10m"], {
      "PATCH /api/tasks/t1/scheduled-messages/s1": { id: "s1", nextRunAt: "2026-01-01T00:10:00Z" },
    });
    assert.equal(code, 0, err);
    assert.deepEqual(calls[0].body, { content: "new text", schedule: { mode: "delay", amount: 10, unit: "minute" } });
  });

  it("schedule update with nothing to change is an args error", async () => {
    const { code, calls } = await runWithFetch(main, ["schedule", "update", "t1", "s1"], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });
});
