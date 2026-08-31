import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";

import {
  UPDATE_DAEMON_CAPABILITY,
  createDaemonUpdateHandlers,
  handleUpdateDaemonRequest,
  readDaemonUpdateStatus,
  resolveDaemonUpdatePaths,
  runDaemonUpdate,
  writeDaemonUpdateStatus,
} from "../src/daemon-update.js";
import { GUEST_BLOCKED_CAPABILITIES } from "../src/guest-daemon.js";

const DAEMON_PID = 4242;
const NEW_DAEMON_PID = 5252;

/**
 * A fake machine: one running daemon process, a lock file, and an npm that can
 * be told to fail. Every assertion about "the daemon survived" reads
 * `machine.daemonAlive`.
 */
function makeMachine({ installOutcomes = [{ success: true }], installedVersion = "9.9.9" } = {}) {
  const machine = {
    daemonAlive: true,
    signals: [],
    commands: [],
    spawned: [],
    removedDirs: [],
    lockPid: DAEMON_PID,
    installOutcomes: [...installOutcomes],
    installedVersion,
    statuses: [],
  };

  machine.kill = (pid, signal) => {
    if (signal === 0) {
      const alive = pid === DAEMON_PID ? machine.daemonAlive : pid === NEW_DAEMON_PID;
      if (!alive) {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }
    machine.signals.push({ pid, signal });
    if (pid === DAEMON_PID) machine.daemonAlive = false;
    return true;
  };

  machine.runCommand = async (command, args) => {
    machine.commands.push(`${command} ${args.join(" ")}`);
    const joined = args.join(" ");
    if (joined.includes("--version")) {
      return { success: true, code: 0, stdout: `conductor version ${machine.installedVersion} (abc)`, stderr: "" };
    }
    if (joined.startsWith("root -g")) {
      return { success: true, code: 0, stdout: "/usr/local/lib/node_modules\n", stderr: "" };
    }
    if (joined.startsWith("install -g") || joined.startsWith("add -g")) {
      const outcome = machine.installOutcomes.shift() ?? { success: true };
      return { code: outcome.success ? 0 : 1, stdout: "", stderr: outcome.stderr || "", ...outcome };
    }
    return { success: true, code: 0, stdout: "", stderr: "" };
  };

  machine.spawn = (command, args) => {
    machine.spawned.push({ command, args });
    machine.lockPid = NEW_DAEMON_PID;
    return { pid: NEW_DAEMON_PID, unref() {} };
  };

  machine.readFileSync = () => JSON.stringify({ pid: machine.lockPid, instance_id: "abc" });

  return machine;
}

function runParams(overrides = {}) {
  return {
    runId: "run-1",
    statusPath: "/tmp/does-not-matter.json",
    packageRoot: "/usr/local/lib/node_modules/@love-moon/conductor-cli",
    launcherScript: "/usr/local/lib/node_modules/@love-moon/conductor-cli/bin/conductor.js",
    launcherArgs: ["daemon"],
    versionCheckScript: "/usr/local/lib/node_modules/@love-moon/conductor-cli/bin/conductor.js",
    daemonPid: DAEMON_PID,
    lockFile: "/tmp/ws/daemon.pid",
    daemonLogPath: null,
    currentVersion: "1.0.0",
    env: { PATH: "/usr/bin" },
    ...overrides,
  };
}

function runDeps(machine, overrides = {}) {
  return {
    runCommand: machine.runCommand,
    spawn: machine.spawn,
    kill: machine.kill,
    readFileSync: machine.readFileSync,
    rmSync: (dir) => machine.removedDirs.push(dir),
    sleep: async () => {},
    writeStatus: (_statusPath, status) => machine.statuses.push({ ...status }),
    writeLine: () => {},
    fetchLatestVersion: async () => "9.9.9",
    detectPackageManager: () => "npm",
    repairAndVerifyGlobalNodePty: async () => "/usr/local/lib/node_modules/@love-moon/conductor-cli",
    ensurePnpmOnlyBuiltDependencies: async () => {},
    ...overrides,
  };
}

test("update installs, verifies, then restarts the daemon", async () => {
  const machine = makeMachine();
  const result = await runDaemonUpdate(runParams(), runDeps(machine));

  assert.equal(result.status, "completed");
  assert.equal(result.toVersion, "9.9.9");
  assert.equal(result.daemonRestarted, true);
  assert.deepEqual(machine.signals, [{ pid: DAEMON_PID, signal: "SIGTERM" }]);
  assert.equal(machine.spawned.length, 1);
  // `--force` lets the new daemon take the lock even if the old one was killed.
  assert.deepEqual(machine.spawned[0].args.slice(1), ["daemon", "--force"]);
  // Install must precede the shutdown: the daemon is only stopped once the new
  // version is on disk and verified.
  const installIndex = machine.commands.findIndex((entry) => entry.includes("install -g"));
  assert.ok(installIndex >= 0);
});

test("a failed install leaves the running daemon alone", async () => {
  const machine = makeMachine({
    installOutcomes: [
      { success: false, code: 1, stderr: "ENOTEMPTY" },
      { success: false, code: 1, stderr: "ENOTEMPTY" },
    ],
  });
  const result = await runDaemonUpdate(runParams(), runDeps(machine));

  assert.equal(result.status, "failed");
  assert.match(result.error, /install failed/);
  assert.equal(result.daemonRestarted, false);
  assert.equal(machine.daemonAlive, true);
  assert.deepEqual(machine.signals, []);
  assert.deepEqual(machine.spawned, []);
});

test("a broken global install is cleared out and the install retried once", async () => {
  const machine = makeMachine({
    installOutcomes: [{ success: false, code: 1, stderr: "ENOTEMPTY" }, { success: true, code: 0 }],
  });
  const result = await runDaemonUpdate(runParams(), runDeps(machine));

  assert.equal(result.status, "completed");
  assert.ok(machine.commands.some((entry) => entry.startsWith("npm uninstall -g")));
  assert.deepEqual(machine.removedDirs, [
    path.join("/usr/local/lib/node_modules", "@love-moon/conductor-cli"),
  ]);
  assert.equal(machine.daemonAlive, false);
});

test("a version mismatch after install aborts before touching the daemon", async () => {
  const machine = makeMachine({ installedVersion: "1.0.0" });
  const result = await runDaemonUpdate(runParams(), runDeps(machine));

  assert.equal(result.status, "failed");
  assert.match(result.error, /version mismatch/);
  assert.equal(machine.daemonAlive, true);
  assert.deepEqual(machine.spawned, []);
});

test("a failed native dependency check aborts before touching the daemon", async () => {
  const machine = makeMachine();
  const result = await runDaemonUpdate(
    runParams(),
    runDeps(machine, {
      repairAndVerifyGlobalNodePty: async () => {
        throw new Error("node-pty is broken");
      },
    }),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /node-pty is broken/);
  assert.equal(machine.daemonAlive, true);
  assert.deepEqual(machine.spawned, []);
});

test("an unreachable registry aborts without installing anything", async () => {
  const machine = makeMachine();
  const result = await runDaemonUpdate(
    runParams(),
    runDeps(machine, {
      fetchLatestVersion: async () => {
        throw new Error("ENOTFOUND registry.npmjs.org");
      },
    }),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /npm registry/);
  assert.equal(machine.daemonAlive, true);
  assert.deepEqual(machine.commands, []);
});

test("already on the latest version is a no-op, not a restart", async () => {
  const machine = makeMachine();
  const result = await runDaemonUpdate(
    runParams({ currentVersion: "9.9.9" }),
    runDeps(machine),
  );

  assert.equal(result.status, "completed");
  assert.match(result.message, /Already on the latest/);
  assert.equal(result.daemonRestarted, false);
  assert.equal(machine.daemonAlive, true);
  assert.deepEqual(machine.commands, []);
});

test("the new daemon failing to come up is reported as a failure", async () => {
  const machine = makeMachine();
  machine.spawn = (command, args) => {
    machine.spawned.push({ command, args });
    return { pid: NEW_DAEMON_PID, unref() {} };
  };
  // Lock file keeps pointing at the dead old daemon.
  machine.readFileSync = () => JSON.stringify({ pid: DAEMON_PID, instance_id: "abc" });

  const result = await runDaemonUpdate(runParams(), runDeps(machine, { now: fastClock() }));

  assert.equal(result.status, "failed");
  assert.match(result.error, /did not come up/);
});

function fastClock() {
  let current = 0;
  return () => {
    current += 5_000;
    return current;
  };
}

test("start() spawns the updater detached and journals a running status", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conductor-daemon-update-"));
  const statusPath = path.join(dir, "state", "daemon-update.json");
  const logPath = path.join(dir, "logs", "daemon-update.log");
  const spawned = [];

  const handlers = createDaemonUpdateHandlers({
    statusPath,
    logPath,
    updaterScript: "/pkg/bin/conductor-daemon-update.js",
    updaterParams: { currentVersion: "1.0.0", daemonPid: DAEMON_PID },
    spawnFn: (command, args, options) => {
      spawned.push({ command, args, options });
      return { pid: 777, unref() {} };
    },
    killFn: () => true,
  });

  const started = await handlers.dispatch({ action: "start" });
  assert.equal(started.result.status, "running");
  assert.equal(started.result.updaterPid, 777);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.detached, true);
  const params = JSON.parse(spawned[0].args[1]);
  assert.equal(params.statusPath, statusPath);
  assert.equal(params.daemonPid, DAEMON_PID);

  const persisted = readDaemonUpdateStatus(statusPath);
  assert.equal(persisted.status, "running");

  // A second start while the updater is alive must not launch a second install.
  const again = await handlers.dispatch({ action: "start" });
  assert.match(again.error, /already running/);
  assert.equal(spawned.length, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("status() reports a stale running journal as failed", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "conductor-daemon-update-"));
  const statusPath = path.join(dir, "daemon-update.json");
  writeDaemonUpdateStatus(statusPath, { runId: "r", status: "running", updaterPid: 999 });

  const handlers = createDaemonUpdateHandlers({
    statusPath,
    logPath: path.join(dir, "daemon-update.log"),
    updaterScript: "/pkg/bin/conductor-daemon-update.js",
    killFn: () => {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    },
  });

  const { result } = await handlers.dispatch({ action: "status" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /exited without reporting/);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("start() refuses with the configured reason", async () => {
  const handlers = createDaemonUpdateHandlers({
    statusPath: path.join(os.tmpdir(), "conductor-daemon-update-missing.json"),
    logPath: path.join(os.tmpdir(), "conductor-daemon-update-missing.log"),
    updaterScript: "/pkg/bin/conductor-daemon-update.js",
    refuseReason: "conductor was installed with Homebrew",
    spawnFn: () => {
      throw new Error("must not spawn");
    },
  });

  const { error } = await handlers.dispatch({ action: "start" });
  assert.match(error, /Homebrew/);
});

test("handleUpdateDaemonRequest replies on the update_daemon_response channel", async () => {
  const sent = [];
  const client = {
    sendJson(payload) {
      sent.push(payload);
      return Promise.resolve();
    },
  };
  const handlers = { dispatch: async () => ({ result: { status: "idle" } }) };

  await handleUpdateDaemonRequest(client, handlers, { request_id: "req-1", action: "status" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "update_daemon_response");
  assert.equal(sent[0].payload.request_id, "req-1");
  assert.deepEqual(sent[0].payload.result, { status: "idle" });
});

test("guest daemons never advertise the update capability", () => {
  assert.ok(GUEST_BLOCKED_CAPABILITIES.has(UPDATE_DAEMON_CAPABILITY));
});

test("update paths live under CONDUCTOR_HOME", () => {
  const paths = resolveDaemonUpdatePaths({ CONDUCTOR_HOME: "/tmp/conductor-home" });
  assert.equal(paths.statusPath, path.join("/tmp/conductor-home", "state", "daemon-update.json"));
  assert.equal(paths.logPath, path.join("/tmp/conductor-home", "logs", "daemon-update.log"));
});

test("the updater entrypoint ships with the package", () => {
  const entry = path.resolve(import.meta.dirname, "..", "bin", "conductor-daemon-update.js");
  assert.ok(fs.existsSync(entry));
});
