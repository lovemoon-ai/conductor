import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startDaemon as startDaemonReal } from "../src/daemon.js";
import {
  deleteFireSessionRecord,
  pruneFireSessionRecords,
  readFireSessionRecord,
  resolveFireSessionRegistryDir,
  writeFireSessionRecord,
} from "../src/fire-session-registry.js";

// Regression suite for "daemon kills the tmux Fires its predecessor
// deliberately left running".
//
// The bug recurred three times (2026-07-23 / 2026-07-31 / 2026-08-31) and the
// 2026-08-31 postmortem names the reason it kept coming back: there was no
// test. A local E2E also showed that patching only `reconcileAssignedTasks`
// leaves the bug fully intact, because the startup path
// (`recoverStaleTasks`) is the one a daemon restart actually goes through and
// it has no grace period at all. Both paths are therefore covered here, over
// the same three scenarios:
//
//   A. tmux session alive        -> task must survive (adopted, not killed)
//   B. no tmux session           -> task must still be killed (no regression)
//   C. session alive, fire dead  -> orphaned shell killed, task killed
//
// Scenario C is what distinguishes real adoption from a bare "skip the kill":
// skipping alone would leave the task at `running` with nothing watching it.

const startDaemon = (config, deps = {}) =>
  startDaemonReal(config, {
    createAiManagerHandlers: () => ({ manager: { checkInstallAll: async () => ({}) } }),
    ...deps,
  });

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5, message = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function restoreEnv(key, value) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

// Same reasoning as daemon.test.js: CONDUCTOR_CONFIG/CONDUCTOR_HOME outrank
// HOME in `resolveConductorConfigPath`, so a run from inside a Conductor task
// shell would otherwise load the developer's real config and real credentials.
const ISOLATED_ENV_KEYS = [
  "HOME",
  "CONDUCTOR_CONFIG",
  "CONDUCTOR_HOME",
  "CONDUCTOR_FIRE_TMUX_MODE",
  "CONDUCTOR_AGENT_TOKEN",
  "CONDUCTOR_BACKEND_URL",
  "CONDUCTOR_WS_URL",
];

const AGENT_NAME = "adoption-daemon";
const TASK_ID = "11111111-2222-3333-4444-555555555555";
const PROJECT_ID = "proj-adopt";
// Mirrors buildFireTmuxSessionPrefix: the task id is sanitized and clamped to
// 32 chars, which is why a session name cannot be reversed back into one.
const SESSION_NAME = `conductor-fire-${TASK_ID.slice(0, 32)}-abc123`;

describe("daemon tmux Fire adoption", () => {
  let previousEnv;
  let homeDir;

  before(() => {
    previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-adopt-home-"));
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    process.env.HOME = homeDir;
    process.env.CONDUCTOR_HOME = path.join(homeDir, ".conductor");
  });

  after(() => {
    for (const [key, value] of previousEnv ?? []) restoreEnv(key, value);
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  });

  // --- fire-session-registry -------------------------------------------------

  describe("hand-off record registry", () => {
    const withRegistryDir = (fn) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fire-registry-"));
      try {
        return fn(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    it("round-trips the fields a successor daemon cannot recompute", () => {
      withRegistryDir((dir) => {
        writeFireSessionRecord(dir, {
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          tmuxSession: SESSION_NAME,
          logPath: "/tmp/x/conductor.log",
          logStartOffset: 4096,
          exitMarkerToken: "deadbeefcafe",
          spawnedAtMs: 1700000000000,
          daemonName: AGENT_NAME,
        });

        const record = readFireSessionRecord(dir, SESSION_NAME);
        assert.strictEqual(record.taskId, TASK_ID);
        assert.strictEqual(record.projectId, PROJECT_ID);
        assert.strictEqual(record.logPath, "/tmp/x/conductor.log");
        assert.strictEqual(record.logStartOffset, 4096);
        // The nonce is the whole point: it is generated per spawn and cannot
        // be reconstructed, so without persisting it the reaper could never
        // read an adopted fire's exit marker.
        assert.strictEqual(record.exitMarkerToken, "deadbeefcafe");
        assert.strictEqual(record.spawnedAtMs, 1700000000000);
      });
    });

    it("returns null rather than a half-trusted record for corrupt input", () => {
      withRegistryDir((dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${SESSION_NAME}.json`), "{not json", "utf8");
        assert.strictEqual(readFireSessionRecord(dir, SESSION_NAME), null);

        // A record filed under a name it does not claim as its own could only
        // come from tampering or a botched rename; refuse it.
        fs.writeFileSync(
          path.join(dir, `${SESSION_NAME}.json`),
          JSON.stringify({ version: 1, taskId: TASK_ID, tmuxSession: "conductor-fire-other-1" }),
          "utf8",
        );
        assert.strictEqual(readFireSessionRecord(dir, SESSION_NAME), null);
      });
    });

    it("refuses session names that would escape the registry directory", () => {
      withRegistryDir((dir) => {
        assert.strictEqual(
          writeFireSessionRecord(dir, {
            taskId: TASK_ID,
            tmuxSession: "../../../etc/passwd",
          }),
          false,
        );
        assert.strictEqual(readFireSessionRecord(dir, "../../../etc/passwd"), null);
        assert.strictEqual(deleteFireSessionRecord(dir, "../../../etc/passwd"), false);
      });
    });

    it("prunes records whose session is gone and leaves live ones alone", () => {
      withRegistryDir((dir) => {
        for (const session of [SESSION_NAME, "conductor-fire-gone-1"]) {
          writeFireSessionRecord(dir, { taskId: `t-${session}`, tmuxSession: session });
        }
        pruneFireSessionRecords(dir, [SESSION_NAME]);
        assert.ok(readFireSessionRecord(dir, SESSION_NAME));
        assert.strictEqual(readFireSessionRecord(dir, "conductor-fire-gone-1"), null);
      });
    });
  });

  // --- daemon behaviour ------------------------------------------------------

  // Drives a daemon whose only interesting inputs are (a) what `tmux
  // list-sessions` reports and (b) what `GET /api/tasks` returns. Both stale
  // sweeps read exactly those two things, so this is enough to reproduce the
  // production kill without any real tmux server or backend.
  const runScenario = async ({
    tmuxSessions,
    // Sessions that only become visible after the first connect has fully
    // settled. Lets a case exercise the reconnect guard in isolation: neither
    // startup adoption nor the startup sweep can see the session, so any
    // survival afterwards is reconcileAssignedTasks' doing.
    tmuxSessionsAfterFirstConnect = null,
    handOffRecord = null,
    logContents = null,
    reconnects = 0,
    // Model `tmux list-sessions` that cannot answer (wedged server, tmux
    // missing, probe timeout) rather than answering "no sessions".
    tmuxProbeUnanswerable = false,
  }) => {
    const conductorHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-adopt-run-"));
    const registryDir = resolveFireSessionRegistryDir(conductorHome);
    const previousConductorHome = process.env.CONDUCTOR_HOME;
    const previousTmuxMode = process.env.CONDUCTOR_FIRE_TMUX_MODE;
    process.env.CONDUCTOR_HOME = conductorHome;
    process.env.CONDUCTOR_FIRE_TMUX_MODE = "true";

    const logPath = path.join(conductorHome, "conductor.log");
    if (logContents !== null) {
      fs.writeFileSync(logPath, logContents, "utf8");
    }
    if (handOffRecord) {
      writeFireSessionRecord(registryDir, {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        tmuxSession: SESSION_NAME,
        logPath,
        logStartOffset: 0,
        spawnedAtMs: Date.now() - 60 * 60 * 1000,
        daemonName: AGENT_NAME,
        ...handOffRecord,
      });
    }

    const killedTaskIds = [];
    const killedSessions = [];
    const listSessionCalls = [];
    let visibleSessions = tmuxSessions;
    let survivingRecords = [];
    let onConnected;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: path.join(conductorHome, "ws"),
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: AGENT_NAME,
        AGENT_TOKEN: "agent-token-abcdefgh12345678",
        TMUX_LIVENESS_POLL_MS: 0,
      },
      {
        spawn: (cmd, args) => {
          const child = new EventEmitter();
          child.pid = 4242;
          child.unref = () => {};
          child.kill = () => {};
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          if (cmd === "tmux" && args?.[0] === "list-sessions") {
            const names = visibleSessions;
            listSessionCalls.push(args);
            if (tmuxProbeUnanswerable) {
              // `spawn` itself failing is the cheapest faithful model of "we
              // could not ask tmux"; the timeout path lands in the same place.
              setImmediate(() => child.emit("error", new Error("tmux unavailable")));
              return child;
            }
            setImmediate(() => {
              child.stdout.emit("data", Buffer.from(`${names.join("\n")}\n`));
              // tmux exits non-zero for "no server running", which is how a
              // box with no sessions actually answers.
              child.emit("exit", names.length ? 0 : 1);
            });
            return child;
          }
          if (cmd === "tmux" && args?.[0] === "kill-session") {
            killedSessions.push(args[2]);
            setImmediate(() => child.emit("exit", 0));
            return child;
          }
          setImmediate(() => child.emit("exit", 0));
          return child;
        },
        spawnSync: (cmd, args) => {
          // Keep the `tmux -V` availability probe deterministic: without it
          // FIRE_TMUX_MODE_ACTIVE depends on whether the dev box has tmux.
          if (cmd === "tmux" && args?.[0] === "-V") {
            return { status: 0, error: null, pid: 12345 };
          }
          return { status: 1, error: new Error("ENOENT"), pid: undefined };
        },
        fetch: async (url, options = {}) => {
          const target = String(url);
          if (target.endsWith("/api/tasks") && (options.method || "GET") === "GET") {
            return {
              ok: true,
              json: async () => [
                {
                  id: TASK_ID,
                  project_id: PROJECT_ID,
                  status: "running",
                  agent_host: AGENT_NAME,
                  // Older than RECONCILE_GRACE_PERIOD_MS so the reconnect
                  // path cannot pass for the wrong reason.
                  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                },
              ],
            };
          }
          if (options.method === "PATCH" && target.includes("/api/tasks/")) {
            killedTaskIds.push(target.split("/api/tasks/")[1]);
            return { ok: true, json: async () => ({}) };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_sdkConfig, handlers = {}) => {
          onConnected = handlers.onConnected;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async () => {},
          };
        },
      },
    );

    try {
      // Mirror production ordering: startup adoption is kicked off before
      // `client.connect()`, so the first probe always precedes onConnected.
      await waitUntil(() => listSessionCalls.length > 0, {
        message: "startup tmux list-sessions probe",
      });
      await waitUntil(() => typeof onConnected === "function", { message: "ws client wiring" });
      // First connect always runs recoverStaleTasks (the startup path).
      onConnected({ isReconnect: false, connectedAt: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (tmuxSessionsAfterFirstConnect) {
        visibleSessions = tmuxSessionsAfterFirstConnect;
      }
      for (let i = 0; i < reconnects; i += 1) {
        // Every later connect takes the reconcileAssignedTasks branch. The
        // 2026-08-31 incident ran this roughly twice a second.
        onConnected({ isReconnect: true, connectedAt: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } finally {
      try {
        survivingRecords = fs.readdirSync(registryDir);
      } catch {
        survivingRecords = [];
      }
      await daemonInstance.close();
      restoreEnv("CONDUCTOR_HOME", previousConductorHome);
      restoreEnv("CONDUCTOR_FIRE_TMUX_MODE", previousTmuxMode);
      fs.rmSync(conductorHome, { recursive: true, force: true });
    }

    return { killedTaskIds, killedSessions, survivingRecords };
  };

  // --- Scenario A: the survivor ---------------------------------------------

  // The whole point of the fix. Shutdown deliberately leaves tmux Fires
  // running, so an empty `activeTaskProcesses` on the next boot is the
  // expected state, not evidence of death.
  it("adopts a task whose tmux Fire is still alive instead of killing it", async () => {
    const { killedTaskIds } = await runScenario({
      tmuxSessions: [SESSION_NAME],
      handOffRecord: { exitMarkerToken: "tok123456789a" },
      logContents: "fire is still talking\n",
    });
    assert.deepStrictEqual(
      killedTaskIds,
      [],
      "a task with a live tmux Fire must never be PATCHed to killed",
    );
  });

  // A live session with no hand-off record is still a live Fire; it just
  // cannot be classified as precisely when it ends. Killing running work is
  // the worse error, so it is adopted too — in degraded mode.
  it("adopts a live session even without a hand-off record", async () => {
    const { killedTaskIds } = await runScenario({ tmuxSessions: [SESSION_NAME] });
    assert.deepStrictEqual(killedTaskIds, []);
  });

  // The 2026-08-31 amplifier: four same-named daemons fought over one backend
  // slot and produced a reconnect roughly every two seconds, each one running
  // reconcileAssignedTasks against an empty in-memory map.
  it("survives repeated reconnects once adopted", async () => {
    const { killedTaskIds } = await runScenario({
      tmuxSessions: [SESSION_NAME],
      handOffRecord: { exitMarkerToken: "tok123456789a" },
      logContents: "fire is still talking\n",
      reconnects: 5,
    });
    assert.deepStrictEqual(killedTaskIds, []);
  });

  // Isolates the reconnect guard: the session is invisible to startup
  // adoption, so the only thing that can save the task on the second connect
  // is reconcileAssignedTasks doing its own tmux lookup. Without that guard
  // this kills the task twice.
  it("adopts a live tmux Fire that only reconcileAssignedTasks can see", async () => {
    const { killedTaskIds } = await runScenario({
      tmuxSessions: [],
      tmuxSessionsAfterFirstConnect: [SESSION_NAME],
      reconnects: 3,
    });
    assert.deepStrictEqual(
      killedTaskIds,
      [TASK_ID],
      "only the startup sweep (which could not see the session) may kill",
    );
  });

  // --- Scenario B: the regression guard --------------------------------------

  // Adoption must not become a blanket amnesty. A task with no session really
  // is dead, and leaving it at `running` was never the goal.
  it("still kills a task that has no tmux session", async () => {
    const { killedTaskIds } = await runScenario({ tmuxSessions: [] });
    assert.deepStrictEqual(killedTaskIds, [TASK_ID]);
  });

  // --- Scenario C: the orphaned shell ---------------------------------------

  // The failure mode a bare "skip the kill" patch introduces. The session
  // outlived the fire inside it, so adopting it would park the task at
  // `running` with no watcher: the reaper only speaks when a session
  // disappears, and this one never will.
  it("kills the orphaned shell when a live session's Fire already exited", async () => {
    const { killedTaskIds, killedSessions } = await runScenario({
      tmuxSessions: [SESSION_NAME],
      handOffRecord: { exitMarkerToken: "tok123456789a" },
      logContents: "fire output\n[conductor-fire-exit:tok123456789a] code=0\n",
    });
    assert.deepStrictEqual(
      killedSessions,
      [SESSION_NAME],
      "an orphaned wrapper shell must be cleaned up, not adopted",
    );
    assert.deepStrictEqual(
      killedTaskIds,
      [TASK_ID],
      "the task behind an orphaned shell must still reach a terminal state",
    );
  });

  // A marker from a *previous* run of the same task must not be read as this
  // run's: the log is opened with flags "a" and survives in-place restarts,
  // which is what `logStartOffset` and the per-spawn nonce exist to separate.
  it("ignores an exit marker written before the adopted run started", async () => {
    const previousRun = "older run\n[conductor-fire-exit:oldtoken1234] code=1\n";
    const { killedTaskIds, killedSessions } = await runScenario({
      tmuxSessions: [SESSION_NAME],
      handOffRecord: {
        exitMarkerToken: "tok123456789a",
        logStartOffset: Buffer.byteLength(previousRun, "utf8"),
      },
      logContents: `${previousRun}current run still going\n`,
    });
    assert.deepStrictEqual(killedSessions, []);
    assert.deepStrictEqual(killedTaskIds, []);
  });

  // --- an unanswerable tmux probe is not evidence of death -------------------

  // `tmux list-sessions` returns an empty list both for "no sessions" and for
  // "could not ask". Treating the second as the first turns ONE flaky probe
  // into the 2026-08-31 mass kill — and `recoverStaleTasks` runs once per
  // process, so there is no second chance to undo it.
  it("kills nothing when tmux cannot be asked", async () => {
    const { killedTaskIds } = await runScenario({
      tmuxSessions: [SESSION_NAME],
      handOffRecord: { exitMarkerToken: "tok123456789a" },
      logContents: "fire is still talking\n",
      tmuxProbeUnanswerable: true,
      reconnects: 2,
    });
    assert.deepStrictEqual(
      killedTaskIds,
      [],
      "a probe that could not answer must never authorize a kill",
    );
  });

  // The startup prune deletes every record whose session is absent from the
  // listing. Running it on a blind listing would wipe the exitMarkerToken of
  // every live Fire on the host, permanently downgrading them all to
  // `adoptedWithoutMetadata` — a transient failure made permanent.
  it("keeps every hand-off record when tmux cannot be asked", async () => {
    const { survivingRecords } = await runScenario({
      tmuxSessions: [SESSION_NAME],
      handOffRecord: { exitMarkerToken: "tok123456789a" },
      logContents: "fire is still talking\n",
      tmuxProbeUnanswerable: true,
    });
    assert.deepStrictEqual(
      survivingRecords,
      [`${SESSION_NAME}.json`],
      "a blind listing must not be read as 'these sessions are all gone'",
    );
  });

  // `FIRE_TMUX_MODE_ACTIVE` is decided once, by a `tmux -V` spawnSync at
  // startup. A transient failure there makes the daemon believe tmux is absent
  // for its whole life — and the conclusiveness guard above never even runs,
  // because the sweeps skip the tmux lookup entirely. Same mass kill, different
  // door.
  it("kills nothing when tmux is reachable but the startup probe said otherwise", async () => {
    const { killedTaskIds } = await runScenarioWithFailedStartupProbe();
    assert.deepStrictEqual(
      killedTaskIds,
      [],
      "a stale `tmux -V` snapshot must not authorize killing Fires the daemon cannot see",
    );
  });

  async function runScenarioWithFailedStartupProbe() {
    const conductorHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-adopt-probe-"));
    const previousConductorHome = process.env.CONDUCTOR_HOME;
    const previousTmuxMode = process.env.CONDUCTOR_FIRE_TMUX_MODE;
    process.env.CONDUCTOR_HOME = conductorHome;
    process.env.CONDUCTOR_FIRE_TMUX_MODE = "true";

    const killedTaskIds = [];
    let onConnected;
    let versionProbes = 0;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: path.join(conductorHome, "ws"),
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: AGENT_NAME,
        AGENT_TOKEN: "agent-token-abcdefgh12345678",
        TMUX_LIVENESS_POLL_MS: 0,
      },
      {
        spawn: () => {
          const child = new EventEmitter();
          child.unref = () => {};
          child.kill = () => {};
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          setImmediate(() => child.emit("exit", 0));
          return child;
        },
        spawnSync: (cmd, args) => {
          if (cmd === "tmux" && args?.[0] === "-V") {
            versionProbes += 1;
            // Fail ONLY the startup probe; tmux is healthy from then on.
            return versionProbes === 1
              ? { status: 1, error: new Error("EAGAIN"), pid: undefined }
              : { status: 0, error: null, pid: 12345 };
          }
          return { status: 1, error: new Error("ENOENT"), pid: undefined };
        },
        fetch: async (url, options = {}) => {
          const target = String(url);
          if (target.endsWith("/api/tasks") && (options.method || "GET") === "GET") {
            return {
              ok: true,
              json: async () => [
                {
                  id: TASK_ID,
                  project_id: PROJECT_ID,
                  status: "running",
                  agent_host: AGENT_NAME,
                  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                },
              ],
            };
          }
          if (options.method === "PATCH" && target.includes("/api/tasks/")) {
            killedTaskIds.push(target.split("/api/tasks/")[1]);
            return { ok: true, json: async () => ({}) };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_sdkConfig, handlers = {}) => {
          onConnected = handlers.onConnected;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async () => {},
          };
        },
      },
    );

    try {
      await waitUntil(() => typeof onConnected === "function", { message: "ws wiring" });
      onConnected({ isReconnect: false, connectedAt: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 200));
      onConnected({ isReconnect: true, connectedAt: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      await daemonInstance.close();
      restoreEnv("CONDUCTOR_HOME", previousConductorHome);
      restoreEnv("CONDUCTOR_FIRE_TMUX_MODE", previousTmuxMode);
      fs.rmSync(conductorHome, { recursive: true, force: true });
    }

    return { killedTaskIds };
  }

  // A record adopted WITHOUT metadata has no exit marker to read, so the
  // reaper's verdict is unconditionally KILLED and the backend status probe is
  // the only thing between a task that finished cleanly and an invented
  // failure. `fetchBackendTaskStatus` returns null both for "not terminal" and
  // for "could not ask" — so a backend blip during a daemon upgrade (when every
  // pre-existing session is adopted without metadata) would mark green tasks
  // killed.
  it("stays silent instead of inventing KILLED when the backend cannot be asked", async () => {
    const { terminalStatuses } = await runDegradedReapScenario({ backendReachable: false });
    assert.deepStrictEqual(
      terminalStatuses,
      [],
      "an unanswerable backend probe must not become a fabricated terminal status",
    );
  });

  // The mirror case: when the backend does answer and says the task is still
  // running, reporting KILLED is correct — silence would strand it forever.
  it("reports KILLED for a degraded adoption once the backend confirms it is not terminal", async () => {
    const { terminalStatuses } = await runDegradedReapScenario({ backendReachable: true });
    assert.deepStrictEqual(terminalStatuses, ["KILLED"]);
  });

  // Adopts SESSION_NAME with no hand-off record, then makes the session vanish
  // so the liveness reaper has to decide what to report.
  async function runDegradedReapScenario({ backendReachable }) {
    const conductorHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-adopt-degraded-"));
    const previousConductorHome = process.env.CONDUCTOR_HOME;
    const previousTmuxMode = process.env.CONDUCTOR_FIRE_TMUX_MODE;
    process.env.CONDUCTOR_HOME = conductorHome;
    process.env.CONDUCTOR_FIRE_TMUX_MODE = "true";

    const terminalStatuses = [];
    let sessionAlive = true;
    let onConnected;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: path.join(conductorHome, "ws"),
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: AGENT_NAME,
        AGENT_TOKEN: "agent-token-abcdefgh12345678",
        TMUX_LIVENESS_POLL_MS: 20,
        TMUX_REAP_GRACE_MS: 0,
      },
      {
        spawn: (cmd, args) => {
          const child = new EventEmitter();
          child.unref = () => {};
          child.kill = () => {};
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          if (cmd === "tmux" && args?.[0] === "list-sessions") {
            setImmediate(() => {
              if (sessionAlive) child.stdout.emit("data", Buffer.from(`${SESSION_NAME}\n`));
              child.emit("exit", sessionAlive ? 0 : 1);
            });
            return child;
          }
          if (cmd === "tmux" && args?.[0] === "has-session") {
            setImmediate(() => child.emit("exit", sessionAlive ? 0 : 1));
            return child;
          }
          setImmediate(() => child.emit("exit", 0));
          return child;
        },
        spawnSync: (cmd, args) =>
          cmd === "tmux" && args?.[0] === "-V"
            ? { status: 0, error: null, pid: 12345 }
            : { status: 1, error: new Error("ENOENT"), pid: undefined },
        fetch: async (url, options = {}) => {
          const target = String(url);
          if (target.endsWith("/api/tasks") && (options.method || "GET") === "GET") {
            return {
              ok: true,
              json: async () => [
                {
                  id: TASK_ID,
                  project_id: PROJECT_ID,
                  status: "running",
                  agent_host: AGENT_NAME,
                  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                },
              ],
            };
          }
          // The reaper's pre-check: a single task GET.
          if (target.includes(`/api/tasks/${TASK_ID}`) && (options.method || "GET") === "GET") {
            if (!backendReachable) throw new Error("backend unreachable");
            return { ok: true, json: async () => ({ status: "running" }) };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_sdkConfig, handlers = {}) => {
          onConnected = handlers.onConnected;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async (payload) => {
              if (payload?.type === "task_status_update" && payload.payload?.task_id === TASK_ID) {
                terminalStatuses.push(payload.payload.status);
              }
            },
          };
        },
      },
    );

    try {
      await waitUntil(() => typeof onConnected === "function", { message: "ws wiring" });
      onConnected({ isReconnect: false, connectedAt: Date.now() });
      // The sweep adopts SESSION_NAME in degraded mode (no hand-off record).
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Now the fire's session disappears; the reaper must decide.
      sessionAlive = false;
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      await daemonInstance.close();
      restoreEnv("CONDUCTOR_HOME", previousConductorHome);
      restoreEnv("CONDUCTOR_FIRE_TMUX_MODE", previousTmuxMode);
      fs.rmSync(conductorHome, { recursive: true, force: true });
    }

    return { terminalStatuses };
  }

  // --- adopted records must behave like the ones we spawned ------------------

  // An adopted record has no `child` (the tmux client belonged to the previous
  // daemon), so any gate written as `record.child` silently reads it as "no
  // fire here". For restart_task that means spawning a SECOND fire into the
  // same worktree next to the live one — the exact double-spawn the tmux
  // probe in that path exists to prevent.
  it("refuses restart_task for an adopted task instead of double-spawning", async () => {
    const { spawnedFireSessions, restartFailures } = await runAdoptedRestartScenario({
      mode: "resume_inplace",
    });
    assert.deepStrictEqual(
      spawnedFireSessions,
      [],
      "restart must not launch a second fire beside the adopted one",
    );
    assert.match(restartFailures.join(" "), /already active in tmux session/);
  });

  // The mirror image: refresh_session_inplace stops the live fire and respawns
  // it. Reading `child` here rejects a task that is genuinely running, so the
  // user's recovery action fails with "task is not active on this daemon".
  it("accepts refresh_session_inplace for an adopted task", async () => {
    const { killedSessions, restartFailures } = await runAdoptedRestartScenario({
      mode: "refresh_session_inplace",
    });
    assert.deepStrictEqual(
      restartFailures.filter((m) => /not active on this daemon/.test(m)),
      [],
      "an adopted fire is active; refresh must not claim otherwise",
    );
    assert.deepStrictEqual(
      killedSessions,
      [SESSION_NAME],
      "refresh stops the adopted session before respawning",
    );
  });

  // Boots a daemon that adopts SESSION_NAME, then hands it a restart_task for
  // the same task and reports what the daemon did about it.
  async function runAdoptedRestartScenario({ mode }) {
    const conductorHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-adopt-restart-"));
    const previousConductorHome = process.env.CONDUCTOR_HOME;
    const previousTmuxMode = process.env.CONDUCTOR_FIRE_TMUX_MODE;
    process.env.CONDUCTOR_HOME = conductorHome;
    process.env.CONDUCTOR_FIRE_TMUX_MODE = "true";

    const logPath = path.join(conductorHome, "conductor.log");
    fs.writeFileSync(logPath, "fire still running\n", "utf8");
    writeFireSessionRecord(resolveFireSessionRegistryDir(conductorHome), {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      tmuxSession: SESSION_NAME,
      logPath,
      logStartOffset: 0,
      exitMarkerToken: "tok123456789a",
      spawnedAtMs: Date.now() - 60 * 60 * 1000,
      daemonName: AGENT_NAME,
    });

    const listSessionCalls = [];
    const spawnedFireSessions = [];
    const killedSessions = [];
    const restartFailures = [];
    let handler;
    let onConnected;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: path.join(conductorHome, "ws"),
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: AGENT_NAME,
        AGENT_TOKEN: "agent-token-abcdefgh12345678",
        TMUX_LIVENESS_POLL_MS: 0,
      },
      {
        spawn: (cmd, args) => {
          const child = new EventEmitter();
          child.pid = 4242;
          child.unref = () => {};
          child.kill = () => {};
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          if (cmd === "tmux" && args?.[0] === "list-sessions") {
            listSessionCalls.push(args);
            setImmediate(() => {
              child.stdout.emit("data", Buffer.from(`${SESSION_NAME}\n`));
              child.emit("exit", 0);
            });
            return child;
          }
          if (cmd === "tmux" && args?.[0] === "has-session") {
            // The adopted session is alive.
            setImmediate(() => child.emit("exit", 0));
            return child;
          }
          if (cmd === "tmux" && args?.[0] === "kill-session") {
            killedSessions.push(args[2]);
            setImmediate(() => child.emit("exit", 0));
            return child;
          }
          if (cmd === "tmux" && args?.[0] === "new-session") {
            spawnedFireSessions.push(args[args.indexOf("-s") + 1]);
            setImmediate(() => child.emit("exit", 0));
            return child;
          }
          setImmediate(() => child.emit("exit", 0));
          return child;
        },
        spawnSync: (cmd, args) => {
          if (cmd === "tmux" && args?.[0] === "-V") {
            return { status: 0, error: null, pid: 12345 };
          }
          return { status: 1, error: new Error("ENOENT"), pid: undefined };
        },
        createWriteStream: () => ({ on: () => {}, write: () => {}, end: () => {} }),
        resolveResumeContext: async () => ({ cwd: path.join(conductorHome, "ws") }),
        fetch: async (url, options = {}) => {
          const target = String(url);
          if (target.endsWith("/api/tasks") && (options.method || "GET") === "GET") {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_sdkConfig, handlers = {}) => {
          onConnected = handlers.onConnected;
          return {
            registerHandler: (next) => {
              handler = next;
            },
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async (payload) => {
              const error = payload?.payload?.error || payload?.payload?.summary || "";
              if (error) restartFailures.push(String(error));
            },
          };
        },
      },
    );

    try {
      await waitUntil(() => listSessionCalls.length > 0, { message: "startup adoption" });
      await waitUntil(() => typeof handler === "function" && typeof onConnected === "function", {
        message: "ws wiring",
      });
      onConnected({ isReconnect: false, connectedAt: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 60));

      if (mode === "stop_task") {
        handler({ type: "stop_task", payload: { task_id: TASK_ID, request_id: "req-stop" } });
      } else {
        handler({
          type: "restart_task",
          payload: {
            mode,
            source_task_id: TASK_ID,
            target_task_id: TASK_ID,
            project_id: PROJECT_ID,
            source_backend_type: "codex",
            target_backend_type: "codex",
            source_session_id: "sess-adopted",
            request_id: "req-adopted",
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await daemonInstance.close();
      restoreEnv("CONDUCTOR_HOME", previousConductorHome);
      restoreEnv("CONDUCTOR_FIRE_TMUX_MODE", previousTmuxMode);
      fs.rmSync(conductorHome, { recursive: true, force: true });
    }

    return { spawnedFireSessions, killedSessions, restartFailures };
  }

  // stop_task is the last gate that read `record.child`. An adopted record has
  // none, so it took the "no active process found" branch: the backend row
  // went to `killed` while the fire kept running in its tmux session, still
  // writing to the worktree, with nothing left to notice — the reaper only
  // speaks when a session *disappears*.
  it("stops an adopted task through the active path, not the 'nothing here' branch", async () => {
    const { killedSessions, restartFailures } = await runAdoptedRestartScenario({
      mode: "stop_task",
    });
    assert.ok(
      killedSessions.includes(SESSION_NAME),
      "stopping an adopted task must kill its tmux session",
    );
    // Both branches end up issuing a kill (the inactive branch has its own
    // belt-and-suspenders sweep), so the kill alone does not prove the fix.
    // The summary does: the inactive branch reports "no active process" and
    // leaves `activeTaskProcesses` and the hand-off record untouched.
    assert.deepStrictEqual(
      restartFailures.filter((m) => /no active process/.test(m)),
      [],
      "an adopted record must be recognised as an active task",
    );
    assert.ok(
      restartFailures.some((m) => /tmux kill-session/.test(m)),
      `expected the tmux stop summary; got ${JSON.stringify(restartFailures)}`,
    );
  });

  // The guard must be scoped to the mode it exists for: a non-tmux deployment
  // kills its fires on shutdown, so its stale sweeps must keep working exactly
  // as before and must not consult tmux at all.
  it("does not consult tmux when fire_tmux_mode is off", async () => {
    const previousTmuxMode = process.env.CONDUCTOR_FIRE_TMUX_MODE;
    process.env.CONDUCTOR_FIRE_TMUX_MODE = "false";
    try {
      const { killedTaskIds } = await runScenarioWithoutTmuxMode();
      assert.deepStrictEqual(killedTaskIds, [TASK_ID]);
    } finally {
      restoreEnv("CONDUCTOR_FIRE_TMUX_MODE", previousTmuxMode);
    }
  });

  async function runScenarioWithoutTmuxMode() {
    const conductorHome = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-adopt-notmux-"));
    const previousConductorHome = process.env.CONDUCTOR_HOME;
    process.env.CONDUCTOR_HOME = conductorHome;
    const killedTaskIds = [];
    let onConnected;
    let tmuxProbes = 0;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: path.join(conductorHome, "ws"),
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: AGENT_NAME,
        AGENT_TOKEN: "agent-token-abcdefgh12345678",
        TMUX_LIVENESS_POLL_MS: 0,
      },
      {
        spawn: (cmd, args) => {
          if (cmd === "tmux") tmuxProbes += 1;
          const child = new EventEmitter();
          child.pid = 1;
          child.unref = () => {};
          child.kill = () => {};
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          setImmediate(() => child.emit("exit", 0));
          return child;
        },
        spawnSync: () => ({ status: 1, error: new Error("ENOENT"), pid: undefined }),
        fetch: async (url, options = {}) => {
          const target = String(url);
          if (target.endsWith("/api/tasks") && (options.method || "GET") === "GET") {
            return {
              ok: true,
              json: async () => [
                {
                  id: TASK_ID,
                  project_id: PROJECT_ID,
                  status: "running",
                  agent_host: AGENT_NAME,
                  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                },
              ],
            };
          }
          if (options.method === "PATCH" && target.includes("/api/tasks/")) {
            killedTaskIds.push(target.split("/api/tasks/")[1]);
            return { ok: true, json: async () => ({}) };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_sdkConfig, handlers = {}) => {
          onConnected = handlers.onConnected;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async () => {},
          };
        },
      },
    );

    try {
      await waitUntil(() => typeof onConnected === "function", { message: "ws client wiring" });
      onConnected({ isReconnect: false, connectedAt: Date.now() });
      await waitUntil(() => killedTaskIds.length > 0, { message: "stale kill" });
      assert.strictEqual(tmuxProbes, 0, "non-tmux deployments must not spawn tmux");
    } finally {
      await daemonInstance.close();
      restoreEnv("CONDUCTOR_HOME", previousConductorHome);
      fs.rmSync(conductorHome, { recursive: true, force: true });
    }

    return { killedTaskIds };
  }
});
