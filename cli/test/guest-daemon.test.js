import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  GUEST_RESTART_MAX_MS,
  MAX_GUEST_DAEMONS,
  buildGuestConfigYaml,
  buildGuestEnv,
  filterGuestCapabilities,
  isGuestAiManagerActionAllowed,
  isGuestRestartAllowed,
  isPathInsideGuestRoot,
  nextRestartDelayMs,
  reconcileGuests,
  resolveGuestPaths,
  startOrphanWatchdog,
} from "../src/guest-daemon.js";

const HOME = "/home/alice";

test("guest paths never collide with the host daemon's state or lock", () => {
  const paths = resolveGuestPaths("share-1", "~/conductor-guests/bob", HOME);

  // CONDUCTOR_HOME must differ or the two instances share sessions/, logs/,
  // cache/ and state/ -- and a fire with no project path deletes every other
  // active-fire marker in the shared state dir.
  assert.notEqual(paths.conductorHome, path.join(HOME, ".conductor"));

  // The PID lock lives under CONDUCTOR_WS, not CONDUCTOR_HOME. Sharing it lets
  // `--force` on one instance SIGKILL the other, across accounts.
  assert.notEqual(paths.workspace, path.join(HOME, "ws"));
  assert.ok(paths.workspace.startsWith(path.join(HOME, "conductor-guests", "bob")));
  assert.ok(paths.fireStateDir.startsWith(paths.conductorHome));
});

test("guest paths fall back to a per-share root when none is configured", () => {
  const a = resolveGuestPaths("share-a", null, HOME);
  const b = resolveGuestPaths("share-b", null, HOME);
  assert.notEqual(a.workspace, b.workspace);
  assert.notEqual(a.conductorHome, b.conductorHome);
});

test("guest env removes the owner's inherited credential rather than overwriting", () => {
  const paths = resolveGuestPaths("share-1", null, HOME);
  const env = buildGuestEnv(
    {
      PATH: "/usr/bin",
      CONDUCTOR_AGENT_TOKEN: "OWNER-TOKEN",
      CONDUCTOR_BACKEND_URL: "https://owner",
      CONDUCTOR_DAEMON_NAME: "alice-mbp",
      CONDUCTOR_TASK_ID: "leaked-task",
    },
    paths,
    { shareId: "share-1" },
  );

  // Deleted, not overwritten: the daemon only ignores an inherited token
  // because --config-file was passed. If that precedence ever changes, an
  // absent variable still cannot make the guest run as the owner.
  assert.equal("CONDUCTOR_AGENT_TOKEN" in env, false);
  assert.equal("CONDUCTOR_DAEMON_NAME" in env, false);
  assert.equal("CONDUCTOR_TASK_ID" in env, false);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CONDUCTOR_HOME, paths.conductorHome);
  assert.equal(env.CONDUCTOR_WS, paths.workspace);
  assert.equal(env.CONDUCTOR_FIRE_STATE_DIR, paths.fireStateDir);
});

test("guest root is only enforced when the owner chose one", () => {
  const paths = resolveGuestPaths("share-1", null, HOME);
  // No explicit workspaceRoot on the share -> no confinement invented for it.
  const loose = buildGuestEnv({}, paths, { shareId: "share-1" });
  assert.equal("CONDUCTOR_GUEST_ROOT" in loose, false);

  const scoped = buildGuestEnv({}, paths, { shareId: "share-1", explicitRoot: true });
  assert.equal(scoped.CONDUCTOR_GUEST_ROOT, paths.guestRoot);
});

test("guest config inherits the owner's allow_cli_list", () => {
  // Load-bearing, not cosmetic: `conductor-fire` refuses any backend without an
  // `allow_cli_list` entry unless it is a command-optional SDK backend. Without
  // this the guest starts a task and dies with
  // `Unsupported backend "claude". Supported backends: copilot, dsh.` -- unable
  // to run the very CLIs the machine was shared for.
  const yaml = buildGuestConfigYaml({
    agentToken: "tok",
    backendUrl: "https://api.example",
    guestHost: "g",
    workspace: "/tmp/ws",
    allowCliList: { claude: "claude --dangerously-skip-permissions", codex: "codex" },
  });
  assert.match(yaml, /^allow_cli_list:$/m);
  assert.match(yaml, /^ {2}claude: "claude --dangerously-skip-permissions"$/m);
  assert.match(yaml, /^ {2}codex: "codex"$/m);
});

test("guest config omits an empty allow_cli_list rather than emitting a stub", () => {
  const yaml = buildGuestConfigYaml({
    agentToken: "tok",
    backendUrl: "https://x",
    guestHost: "g",
    workspace: "/w",
    allowCliList: { claude: "  ", broken: 42 },
  });
  assert.equal(/allow_cli_list/.test(yaml), false);
});

test("guest config shares the machine's AI credentials on purpose", () => {
  const yaml = buildGuestConfigYaml({
    agentToken: "tok",
    backendUrl: "https://api.example",
    guestHost: "shared-alice-alice-mbp",
    workspace: "/tmp/ws",
  });
  assert.match(yaml, /daemon_name: "shared-alice-alice-mbp"/);
  // No `remote_exec: false` -- a guest is not less capable than a normal daemon.
  assert.equal(/remote_exec/.test(yaml), false);
  // No `envs:` block: sharing the already-logged-in claude/codex is the point
  // of the feature, so per-instance CODEX_HOME/CLAUDE_CONFIG_DIR must NOT be
  // written here.
  assert.equal(/^envs:/m.test(yaml), false);
});

test("guest config escapes quotes in values", () => {
  const yaml = buildGuestConfigYaml({
    agentToken: 'a"b',
    backendUrl: "https://x",
    guestHost: "h",
    workspace: "/w",
  });
  assert.match(yaml, /agent_token: "a\\"b"/);
});

test("reconcile starts, keeps and stops the right guests", () => {
  const shares = [
    { id: "s1", guestHost: "g1", agentToken: "t1" },
    { id: "s2", guestHost: "g2", agentToken: "t2" },
  ];
  const result = reconcileGuests(shares, new Set(["s1", "s-revoked"]));
  assert.deepEqual(result.keep, ["s1"]);
  assert.deepEqual(result.start.map((s) => s.id), ["s2"]);
  assert.deepEqual(result.stop, ["s-revoked"]);
});

test("reconcile skips shares that cannot be launched", () => {
  // A share with no token or host is half-built; starting a daemon with a
  // partial identity is worse than starting nothing.
  const result = reconcileGuests(
    [
      { id: "s1", guestHost: "g1", agentToken: null },
      { id: "s2", guestHost: null, agentToken: "t" },
      { id: "s3", guestHost: "g3", agentToken: "t3" },
    ],
    new Set(),
  );
  assert.deepEqual(result.start.map((s) => s.id), ["s3"]);
});

test("reconcile caps concurrent guests and reports what it dropped", () => {
  const shares = Array.from({ length: MAX_GUEST_DAEMONS + 2 }, (_, i) => ({
    id: `s${i}`,
    guestHost: `g${i}`,
    agentToken: `t${i}`,
  }));
  const result = reconcileGuests(shares, new Set());
  assert.equal(result.start.length, MAX_GUEST_DAEMONS);
  assert.equal(result.skipped, 2);
});

test("restart backoff grows and is capped", () => {
  assert.equal(nextRestartDelayMs(1), 10_000);
  assert.equal(nextRestartDelayMs(2), 20_000);
  assert.equal(nextRestartDelayMs(99), GUEST_RESTART_MAX_MS);
});

test("a guest advertises the same capabilities as any other daemon", () => {
  // Withholding `remote_exec` was security theatre: the grantee already has a
  // shell here through AI tasks and pty_task's custom entrypoint, so the only
  // effect was breaking legitimate use (running a build, tailing a log).
  const caps = ["project_path_validation", "remote_exec", "pty_task", "custom_commands"];
  assert.deepEqual(filterGuestCapabilities(caps), caps);
});

test("guest refuses a versioned restart but allows a plain one", () => {
  // A versioned restart runs a global `npm install -g`, replacing the CLI
  // binary the owner's own daemon and every one of the owner's fires execute.
  assert.equal(isGuestRestartAllowed({ target_version: "1.2.3" }), false);
  assert.equal(isGuestRestartAllowed({ target_version: "  " }), true);
  assert.equal(isGuestRestartAllowed({}), true);
});

test("guest may read ai_manager state but not switch accounts", () => {
  // switch_account renames over ~/.codex/auth.json, changing the owner's own
  // active account. Reads stay allowed so the grantee can see quota.
  assert.equal(isGuestAiManagerActionAllowed("status"), true);
  assert.equal(isGuestAiManagerActionAllowed("quota"), true);
  assert.equal(isGuestAiManagerActionAllowed("list_accounts"), true);
  assert.equal(isGuestAiManagerActionAllowed("switch_account"), false);
});

test("guest project paths are confined to the guest root", () => {
  const root = "/home/alice/conductor-guests/bob";
  assert.equal(isPathInsideGuestRoot(`${root}/repo`, root), true);
  assert.equal(isPathInsideGuestRoot(root, root), true);
  assert.equal(isPathInsideGuestRoot("/home/alice/.ssh", root), false);
  // Prefix-only matches must not pass.
  assert.equal(isPathInsideGuestRoot(`${root}-evil/x`, root), false);
  assert.equal(isPathInsideGuestRoot(`${root}/../../.ssh`, root), false);
});

test("orphan watchdog fires when the host daemon disappears", async () => {
  // A SIGKILLed host daemon leaves guests running with live credentials.
  // `detached: false` does not help on POSIX -- nothing reaps the child -- so
  // the guest has to notice its parent is gone by itself.
  let ppid = 4242;
  let orphaned = false;
  const stop = startOrphanWatchdog({
    intervalMs: 5,
    ppid,
    readPpid: () => ppid,
    onOrphaned: () => {
      orphaned = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(orphaned, false, "must not fire while the parent is alive");

  ppid = 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  assert.equal(orphaned, true);
});
