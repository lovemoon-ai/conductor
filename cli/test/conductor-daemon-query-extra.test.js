import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main as rawMain, DAEMON_QUERY_VERBS } from "../bin/conductor-daemon-query.js";
import { extractInviteToken } from "../src/daemon-share-commands.js";
import { runWithFetch } from "./helpers/fake-fetch.js";

// Polling verbs sleep between requests; tests never wait on the real clock.
const noSleep = { sleep: async () => {} };
const main = (args, deps) => rawMain(args, { ...noSleep, ...deps });
const run = (args, routes, extra) => runWithFetch(main, args, routes, extra);

describe("DAEMON_QUERY_VERBS", () => {
  it("dispatches the new verbs to the query CLI", () => {
    for (const verb of ["restart", "upgrade", "sessions", "accounts", "switch-account", "commands", "share"]) {
      assert.ok(DAEMON_QUERY_VERBS.has(verb), verb);
    }
  });
});

describe("conductor daemon restart", () => {
  it("POSTs to /restart", async () => {
    const { code, out, calls } = await run(["restart", "macmini"], {
      "POST /api/agents/macmini/restart": () => ({ ok: true }),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {});
    assert.match(out, /Restart requested for macmini/);
  });

  it("passes --target-version and encodes the host", async () => {
    const { code, calls } = await run(["restart", "my host", "--target-version", "1.2.3", "--json"], {
      "POST /api/agents/my%20host/restart": () => ({ ok: true }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { targetVersion: "1.2.3" });
  });

  it("--dry-run sends nothing", async () => {
    const { code, out, calls } = await run(["restart", "macmini", "--dry-run", "--json"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    const payload = JSON.parse(out);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.request.method, "POST");
    assert.equal(payload.request.url, "https://backend.example/api/agents/macmini/restart");
  });

  it("404 maps to exit code 4 with the server reason", async () => {
    const { code, err } = await run(["restart", "gone"], {
      "POST /api/agents/gone/restart": () => ({ status: 404, body: { error: "daemon not connected" } }),
    });
    assert.equal(code, 4);
    assert.match(err, /daemon not connected/);
  });

  it("409 prints the server error", async () => {
    const { code, err } = await run(["restart", "old"], {
      "POST /api/agents/old/restart": () => ({
        status: 409,
        body: { error: "daemon does not support restart (old version)" },
      }),
    });
    assert.equal(code, 1);
    assert.match(err, /does not support restart/);
  });
});

describe("conductor daemon upgrade", () => {
  it("starts an upgrade with POST", async () => {
    const { code, out, calls } = await run(["upgrade", "macmini"], {
      "POST /api/agents/macmini/update": () => ({ runId: "r1", status: "running", phase: "install" }),
    });
    assert.equal(code, 0);
    assert.equal(calls[0].method, "POST");
    assert.match(out, /status: running/);
  });

  it("--status only reads with GET", async () => {
    const { code, out, calls } = await run(["upgrade", "macmini", "--status", "--json"], {
      "GET /api/agents/macmini/update": () => ({ runId: "r1", status: "completed", toVersion: "1.0.0" }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    assert.equal(JSON.parse(out).status, "completed");
  });

  it("--wait polls through a restart gap until a terminal state", async () => {
    const answers = [
      () => ({ status: 503, body: { error: "offline" } }),
      () => ({ runId: "r1", status: "running", phase: "verify" }),
      () => ({ runId: "r1", status: "failed", error: "npm exploded" }),
    ];
    let i = 0;
    const { code, out, calls } = await run(["upgrade", "macmini", "--wait"], {
      "POST /api/agents/macmini/update": () => ({ runId: "r1", status: "running", phase: "install" }),
      "GET /api/agents/macmini/update": () => answers[i++](),
    });
    assert.equal(code, 1);
    assert.equal(calls.length, 4);
    assert.match(out, /error: npm exploded/);
  });

  it("--dry-run sends nothing", async () => {
    const { code, calls, out } = await run(["upgrade", "macmini", "--dry-run"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.match(out, /\[dry-run\] would send:\n {2}POST https:\/\/backend\.example\/api\/agents\/macmini\/update/);
  });
});

describe("conductor daemon sessions", () => {
  const sessions = [
    {
      backend: "claude",
      session_id: "s-1",
      cwd: "/repo",
      title: "Fix the\nbuild",
      updated_at: "2026-09-28T10:00:00Z",
      linked_task_id: "task-9",
    },
    { backend: "codex", session_id: "s-2", cwd: null, title: null, first_user_message: "hello", updated_at: null, linked_task_id: null },
  ];

  it("passes backends/limit and prints a table", async () => {
    const { code, out, err, calls } = await run(
      ["sessions", "macmini", "--backend", "claude,codex", "--limit", "5"],
      {
        "GET /api/agents/macmini/sessions": () => ({ sessions, errors: [{ backend: "kimi", message: "boom" }] }),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { backends: "claude,codex", limit: "5" });
    const lines = out.trim().split("\n");
    assert.match(lines[0], /^BACKEND\s+SESSION\s+UPDATED\s+TASK\s+CWD\s+TITLE$/);
    assert.match(lines[1], /^claude\s+s-1\s+2026-09-28T10:00:00Z\s+task-9\s+\/repo\s+Fix the build$/);
    assert.match(lines[2], /^codex\s+s-2\s+.*hello$/);
    assert.match(err, /warning: kimi: boom/);
  });

  it("--json prints the raw payload", async () => {
    const { out } = await run(["sessions", "macmini", "--json"], {
      "GET /api/agents/macmini/sessions": () => ({ sessions }),
    });
    assert.equal(JSON.parse(out).sessions.length, 2);
  });
});

describe("conductor daemon accounts / switch-account", () => {
  it("lists codex accounts with the current one starred", async () => {
    const { code, out, calls } = await run(["accounts", "macmini"], {
      "GET /api/ai-manager/accounts": () => ({
        accounts: [
          { name: "work", email: "w@x.com", planType: "pro", isCurrent: true },
          { name: "home", isCurrent: false },
        ],
      }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { agentHost: "macmini" });
    assert.match(out, /^\*\s+work\s+w@x\.com\s+pro/m);
    assert.match(out, /^\s+home/m);
  });

  it("switch-account POSTs agentHost + name", async () => {
    const { code, out, calls } = await run(["switch-account", "macmini", "home"], {
      "POST /api/ai-manager/switch": () => ({ previousName: "work", newName: "home", backupPath: "/b" }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { agentHost: "macmini", name: "home" });
    assert.match(out, /to home \(was work\)/);
  });

  it("switch-account --account works and --dry-run sends nothing", async () => {
    const { code, out, calls } = await run(["switch-account", "macmini", "--account", "home", "--dry-run", "--json"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(JSON.parse(out).request.body, { agentHost: "macmini", name: "home" });
  });

  it("switch-account without a name is an args error", async () => {
    const { code, calls } = await run(["switch-account", "macmini"], {});
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });
});

describe("conductor daemon commands", () => {
  it("list prints keys and running state", async () => {
    const { code, out } = await run(["commands", "list", "macmini"], {
      "GET /api/agents/macmini/custom-commands": () => ({
        commands: [{ key: "deploy", running: true, runId: "run-1" }, { key: "lint" }],
      }),
    });
    assert.equal(code, 0);
    assert.match(out, /^deploy\s+running\s+run-1$/m);
    assert.match(out, /^lint\s+idle/m);
  });

  it("run POSTs the key", async () => {
    const { code, out, calls } = await run(["commands", "run", "macmini", "deploy"], {
      "POST /api/agents/macmini/custom-commands/run": () => ({
        started: true, key: "deploy", runId: "run-1", status: "running", startedAt: "t",
      }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { key: "deploy" });
    assert.match(out, /Started deploy \(run run-1, running\)/);
  });

  it("run --wait polls status and prints output; failed exits 1", async () => {
    let polls = 0;
    const { code, out, calls } = await run(["commands", "run", "macmini", "deploy", "--wait"], {
      "POST /api/agents/macmini/custom-commands/run": () => ({ key: "deploy", runId: "run-1", status: "running" }),
      "GET /api/agents/macmini/custom-commands/runs/run-1": () => (++polls < 2
        ? { runId: "run-1", key: "deploy", status: "running" }
        : { runId: "run-1", key: "deploy", status: "failed", exitCode: 3, stdoutTail: "building\n", stderrTail: "oops\n" }),
    });
    assert.equal(code, 1);
    assert.equal(calls.length, 3);
    assert.match(out, /exit code: 3/);
    assert.match(out, /--- stdout \(tail\) ---\nbuilding/);
    assert.match(out, /--- stderr \(tail\) ---\noops/);
  });

  it("run --wait keeps polling through a transient 502", async () => {
    const answers = [
      () => ({ status: 502, body: { error: "daemon did not answer" } }),
      () => ({ runId: "run-1", key: "deploy", status: "completed", exitCode: 0 }),
    ];
    let i = 0;
    const { code, err, calls } = await run(["commands", "run", "macmini", "deploy", "--wait"], {
      "POST /api/agents/macmini/custom-commands/run": () => ({ key: "deploy", runId: "run-1", status: "running" }),
      "GET /api/agents/macmini/custom-commands/runs/run-1": () => answers[i++](),
    });
    assert.equal(code, 0, err);
    assert.equal(calls.length, 3);
    assert.match(err, /status poll failed.*retrying/);
  });

  it("run --wait stops on a 404 from the status route", async () => {
    const { code, calls } = await run(["commands", "run", "macmini", "deploy", "--wait"], {
      "POST /api/agents/macmini/custom-commands/run": () => ({ key: "deploy", runId: "run-1", status: "running" }),
      "GET /api/agents/macmini/custom-commands/runs/run-1": () => ({ status: 404, body: { error: "Run not found" } }),
    });
    assert.equal(code, 4);
    assert.equal(calls.length, 2);
  });

  it("run --dry-run sends nothing", async () => {
    const { code, calls } = await run(["commands", "run", "macmini", "deploy", "--dry-run"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  });

  it("status reads the run and --json prints it", async () => {
    const { code, out, calls } = await run(["commands", "status", "macmini", "run/1", "--json"], {
      "GET /api/agents/macmini/custom-commands/runs/run%2F1": () => ({ runId: "run/1", status: "completed", exitCode: 0 }),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(out).exitCode, 0);
  });

  it("requires a sub-command", async () => {
    const { code } = await run(["commands"], {});
    assert.equal(code, 2);
  });
});

describe("conductor daemon share", () => {
  it("create POSTs daemonHost/workspaceRoot and prints the link", async () => {
    const { code, out, calls } = await run(["share", "create", "macmini", "--workspace-root", "/w"], {
      "POST /api/daemon-shares": () => ({
        status: 201,
        body: { id: "sh1", ownerDaemonHost: "macmini", inviteUrl: "https://app/app/daemon-share/tok", expiresAt: "later" },
      }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { daemonHost: "macmini", workspaceRoot: "/w" });
    assert.match(out, /Invite link: https:\/\/app\/app\/daemon-share\/tok/);
  });

  it("create 409 prints the cap error", async () => {
    const { code, err } = await run(["share", "create", "macmini"], {
      "POST /api/daemon-shares": () => ({
        status: 409, body: { error: "A daemon can be shared with at most 3 people" },
      }),
    });
    assert.equal(code, 1);
    assert.match(err, /at most 3 people/);
  });

  it("create on a borrowed daemon surfaces the server's refusal", async () => {
    const { code, err } = await run(["share", "create", "shared-alice-mbp"], {
      "POST /api/daemon-shares": () => ({
        status: 400, body: { error: "You cannot lend on a daemon lent to you" },
      }),
    });
    assert.equal(code, 2);
    assert.match(err, /cannot lend on a daemon lent to you/);
  });

  it("create --dry-run sends nothing", async () => {
    const { code, calls } = await run(["share", "create", "macmini", "--dry-run"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  });

  it("list filters by --host and prints a table", async () => {
    const { code, out, calls } = await run(["share", "list", "--host", "macmini"], {
      "GET /api/daemon-shares": () => ({
        shares: [
          { id: "sh1", ownerDaemonHost: "macmini", status: "active", granteeLabel: "bob", guestHost: "alice-macmini" },
          { id: "sh2", ownerDaemonHost: "macmini", status: "pending", expiresAt: "soon", inviteUrl: "https://i/2" },
        ],
      }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].query, { daemonHost: "macmini" });
    assert.match(out, /^sh1\s+macmini\s+active\s+bob\s+alice-macmini/m);
    assert.match(out, /^sh2\s+macmini\s+pending\s+.*soon\s+https:\/\/i\/2$/m);
  });

  it("revoke DELETEs the share; 404 exits 4", async () => {
    const ok = await run(["share", "revoke", "sh1"], { "DELETE /api/daemon-shares/sh1": () => ({ ok: true }) });
    assert.equal(ok.code, 0);
    assert.equal(ok.calls[0].method, "DELETE");
    assert.match(ok.out, /Revoked share sh1/);
    const missing = await run(["share", "revoke", "nope"], {
      "DELETE /api/daemon-shares/nope": () => ({ status: 404, body: { error: "Share not found" } }),
    });
    assert.equal(missing.code, 4);
    assert.match(missing.err, /Share not found/);
  });

  it("revoke --dry-run sends nothing", async () => {
    const { code, calls } = await run(["share", "revoke", "sh1", "--dry-run"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  });

  it("show-invite accepts a full URL", async () => {
    const { code, out, calls } = await run(["share", "show-invite", "https://app.example/app/daemon-share/tok123?x=1"], {
      "GET /api/daemon-shares/invitations/tok123": () => ({
        ownerLabel: "alice", ownerDaemonHost: "macmini", status: "pending", isSelf: false, expiresAt: "soon",
      }),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.match(out, /owner: alice/);
    assert.match(out, /daemon: macmini/);
  });

  it("accept POSTs to /accept/:token and prints the guest host", async () => {
    const { code, out, calls } = await run(["share", "accept", "tok123", "--json"], {
      "POST /api/daemon-shares/accept/tok123": () => ({ id: "sh1", guestHost: "alice-macmini" }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, {});
    assert.equal(JSON.parse(out).guestHost, "alice-macmini");
  });

  it("accept 409 prints the server error", async () => {
    const { code, err } = await run(["share", "accept", "tok123"], {
      "POST /api/daemon-shares/accept/tok123": () => ({ status: 409, body: { error: "Invitation already accepted" } }),
    });
    assert.equal(code, 1);
    assert.match(err, /Invitation already accepted/);
  });

  it("accept --dry-run sends nothing", async () => {
    const { code, calls, out } = await run(["share", "accept", "https://a/app/daemon-share/tok9", "--dry-run", "--json"], {});
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.equal(JSON.parse(out).request.url, "https://backend.example/api/daemon-shares/accept/tok9");
  });
});

describe("extractInviteToken", () => {
  it("handles bare tokens, URLs and rejects foreign URLs", () => {
    assert.equal(extractInviteToken("abc"), "abc");
    assert.equal(extractInviteToken("https://x/app/daemon-share/a%2Bb#frag"), "a+b");
    assert.throws(() => extractInviteToken("https://x/other/abc"), /not a daemon share invite URL/);
  });
});

describe("conductor daemon --dry-run on read-only verbs", () => {
  for (const args of [
    ["list"],
    ["tools", "macmini"],
    ["quota", "macmini"],
    ["sessions", "macmini"],
    ["accounts", "macmini"],
    ["commands", "list", "macmini"],
    ["commands", "status", "macmini", "run-1"],
    ["share", "list"],
    ["upgrade", "macmini", "--status"],
  ]) {
    it(`${args.join(" ")} --dry-run is an args error`, async () => {
      const { code, err, calls } = await run([...args, "--dry-run"], {});
      assert.equal(code, 2, err);
      assert.equal(calls.length, 0);
      assert.match(err, /--dry-run/);
    });
  }
});
