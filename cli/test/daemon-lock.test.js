import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  FORCE_KILL_UNKNOWN_OWNER_ENV_VAR,
  buildDaemonInstanceIdentity,
  compareDaemonLockIdentity,
  computeDaemonInstanceId,
  describeForceRestartRefusal,
  parseDaemonLockState,
  serializeDaemonLock,
} from "../src/daemon-lock.js";
import { resolveConductorConfigPath, resolveConductorHome } from "../src/conductor-paths.js";
import { startDaemon } from "../src/daemon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_BIN = path.resolve(__dirname, "..", "bin", "conductor-daemon.js");

const INSTANCE_A = {
  conductorHome: "/tmp/inst-a/.conductor",
  configPath: "/tmp/inst-a/.conductor/config.yaml",
  workspaceRoot: "/tmp/shared-ws",
  daemonName: "alice-box",
  backendUrl: "https://a.example.com",
};
const INSTANCE_B = {
  conductorHome: "/tmp/inst-b/.conductor",
  configPath: "/tmp/inst-b/.conductor/config.yaml",
  workspaceRoot: "/tmp/shared-ws",
  daemonName: "bob-box",
  backendUrl: "https://b.example.com",
};

function restoreEnv(key, value) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

// The identity startDaemon computes for itself given a WORKSPACE_ROOT.
function selfIdentity(workspaceRoot) {
  return buildDaemonInstanceIdentity({
    conductorHome: resolveConductorHome(),
    configPath: resolveConductorConfigPath(),
    workspaceRoot,
  });
}

function foreignIdentity(workspaceRoot) {
  return buildDaemonInstanceIdentity({
    ...INSTANCE_B,
    workspaceRoot,
  });
}

/**
 * Runs startDaemon against a stubbed fs/kill where `lockContents` is already in
 * place at daemon.pid and the recorded pid is alive. Returns what the lock code
 * did without ever touching a real process.
 */
function runLockAcquisition({ workspaceRoot, lockContents, force = true, lockPid }) {
  let exitCode = null;
  const killCalls = [];
  const writes = [];
  let unlinkCalled = false;
  let killed = false;

  const daemonInstance = startDaemon(
    {
      BACKEND_URL: "ws://localhost:0",
      WORKSPACE_ROOT: workspaceRoot,
      CLI_PATH: "/tmp/cli.js",
      DAEMON_NAME: "lock-identity-test",
      FORCE: force,
    },
    {
      spawn: () => ({
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      }),
      mkdirSync: () => {},
      writeFileSync: (filePath, contents) => {
        if (String(filePath).endsWith("daemon.pid")) {
          writes.push(String(contents));
        }
      },
      existsSync: (filePath) => String(filePath).endsWith("daemon.pid"),
      readFileSync: () => lockContents,
      unlinkSync: () => {
        unlinkCalled = true;
      },
      createWriteStream: () => ({ write: () => {}, end: () => {} }),
      fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
      exit: (code) => {
        exitCode = code;
      },
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        if (signal === 0) {
          if (killed) {
            const err = new Error("process not found");
            err.code = "ESRCH";
            throw err;
          }
          return;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          killed = true;
        }
      },
      createWebSocketClient: () => ({
        registerHandler: () => {},
        connect: async () => {},
        disconnect: async () => {},
        sendJson: async () => {},
      }),
    },
  );
  if (daemonInstance && typeof daemonInstance.close === "function") {
    daemonInstance.close();
  }

  return {
    exitCode,
    killCalls,
    writes,
    unlinkCalled,
    lockPid,
    signalsSent: killCalls.filter(([, signal]) => signal !== 0).map(([, signal]) => signal),
  };
}

describe("daemon lock instance identity", () => {
  it("fingerprints on the path axes and ignores mutable config contents", () => {
    const base = computeDaemonInstanceId(INSTANCE_A);
    assert.ok(base);

    // daemon_name / backend_url are recorded but not hashed: renaming a daemon
    // or repointing it at another backend must not break its own --force restart.
    assert.strictEqual(
      buildDaemonInstanceIdentity({ ...INSTANCE_A, daemonName: "renamed", backendUrl: "https://z" })
        .instanceId,
      base,
    );

    for (const field of ["conductorHome", "configPath", "workspaceRoot"]) {
      assert.notStrictEqual(
        computeDaemonInstanceId({ ...INSTANCE_A, [field]: "/tmp/somewhere-else" }),
        base,
        `${field} must be part of the fingerprint`,
      );
    }

    // Non-normalized paths must still fingerprint identically.
    assert.strictEqual(
      computeDaemonInstanceId({ ...INSTANCE_A, workspaceRoot: "/tmp/shared-ws/" }),
      base,
    );
  });

  it("parses legacy bare-pid lock files and identity-bearing JSON lock files", () => {
    const legacy = parseDaemonLockState("4242\n");
    assert.strictEqual(legacy.pid, 4242);
    assert.strictEqual(legacy.instanceId, "");

    const identity = buildDaemonInstanceIdentity(INSTANCE_A);
    const modern = parseDaemonLockState(serializeDaemonLock({ pid: 99, identity }));
    assert.strictEqual(modern.pid, 99);
    assert.strictEqual(modern.instanceId, identity.instanceId);
    assert.strictEqual(modern.daemonName, "alice-box");
    assert.strictEqual(modern.configPath, INSTANCE_A.configPath);

    assert.strictEqual(parseDaemonLockState(""), null);
    assert.strictEqual(parseDaemonLockState("not json"), null);
  });

  it("keeps the handoff fields readable alongside the identity", () => {
    const identity = buildDaemonInstanceIdentity(INSTANCE_A);
    const state = parseDaemonLockState(
      serializeDaemonLock({
        pid: 77,
        identity,
        handoff: { handoffFromPid: 77, handoffToken: "tok", handoffExpiresAt: 1234 },
      }),
    );
    assert.strictEqual(state.pid, 77);
    assert.strictEqual(state.handoffFromPid, 77);
    assert.strictEqual(state.handoffToken, "tok");
    assert.strictEqual(state.handoffExpiresAt, 1234);
    assert.strictEqual(state.instanceId, identity.instanceId);
  });

  it("classifies lock ownership as self, other, or unknown", () => {
    const a = buildDaemonInstanceIdentity(INSTANCE_A);
    const b = buildDaemonInstanceIdentity(INSTANCE_B);
    const lockA = parseDaemonLockState(serializeDaemonLock({ pid: 1, identity: a }));

    assert.strictEqual(compareDaemonLockIdentity(lockA, a), "self");
    assert.strictEqual(compareDaemonLockIdentity(lockA, b), "other");
    assert.strictEqual(compareDaemonLockIdentity(parseDaemonLockState("1"), a), "unknown");
  });

  it("names the other instance when refusing a cross-instance force", () => {
    const lockA = parseDaemonLockState(
      serializeDaemonLock({ pid: 555, identity: buildDaemonInstanceIdentity(INSTANCE_A) }),
    );
    const refusal = describeForceRestartRefusal({
      lockState: lockA,
      identity: buildDaemonInstanceIdentity(INSTANCE_B),
      lockFile: "/tmp/shared-ws/daemon.pid",
      env: {},
    });
    assert.ok(refusal);
    assert.match(refusal, /different Conductor instance/);
    assert.match(refusal, /alice-box/);
    assert.match(refusal, new RegExp(INSTANCE_A.configPath));
    assert.match(refusal, /555/);
    // Even the escape hatch must not unlock a cross-instance kill.
    assert.ok(
      describeForceRestartRefusal({
        lockState: lockA,
        identity: buildDaemonInstanceIdentity(INSTANCE_B),
        env: { [FORCE_KILL_UNKNOWN_OWNER_ENV_VAR]: "1" },
      }),
    );
  });

  it("refuses a legacy identity-less lock unless the operator opts in", () => {
    const legacy = parseDaemonLockState("9001");
    const identity = buildDaemonInstanceIdentity(INSTANCE_A);
    const refusal = describeForceRestartRefusal({ lockState: legacy, identity, env: {} });
    assert.ok(refusal);
    assert.match(refusal, /no instance identity/);
    assert.match(refusal, /kill 9001/);
    assert.match(refusal, new RegExp(FORCE_KILL_UNKNOWN_OWNER_ENV_VAR));

    assert.strictEqual(
      describeForceRestartRefusal({
        lockState: legacy,
        identity,
        env: { [FORCE_KILL_UNKNOWN_OWNER_ENV_VAR]: "1" },
      }),
      null,
    );
  });
});

describe("daemon --force lock ownership", () => {
  it("stops the existing daemon when the lock records this same instance", () => {
    const workspaceRoot = "/tmp/test-ws-force-self";
    const result = runLockAcquisition({
      workspaceRoot,
      lockContents: serializeDaemonLock({ pid: 4321, identity: selfIdentity(workspaceRoot) }),
    });

    assert.strictEqual(result.exitCode, null);
    assert.ok(result.signalsSent.includes("SIGTERM"));
    assert.ok(result.killCalls.every(([pid]) => pid === 4321));
    assert.strictEqual(parseDaemonLockState(result.writes.at(-1))?.pid, process.pid);
  });

  it("refuses to kill a daemon belonging to a different instance and leaves it running", () => {
    const workspaceRoot = "/tmp/test-ws-force-other";
    const result = runLockAcquisition({
      workspaceRoot,
      lockContents: serializeDaemonLock({ pid: 4321, identity: foreignIdentity(workspaceRoot) }),
    });

    assert.strictEqual(result.exitCode, 1);
    // No signal beyond the liveness probe: the other user's daemon survives.
    assert.deepStrictEqual(result.signalsSent, []);
    assert.strictEqual(result.unlinkCalled, false);
    // And we must not steal the lock file either.
    assert.deepStrictEqual(result.writes, []);
  });

  it("refuses a legacy lock file written by an older CLI", () => {
    const previous = process.env[FORCE_KILL_UNKNOWN_OWNER_ENV_VAR];
    try {
      delete process.env[FORCE_KILL_UNKNOWN_OWNER_ENV_VAR];
      const result = runLockAcquisition({
        workspaceRoot: "/tmp/test-ws-force-legacy",
        lockContents: "4321",
      });
      assert.strictEqual(result.exitCode, 1);
      assert.deepStrictEqual(result.signalsSent, []);
      assert.deepStrictEqual(result.writes, []);
    } finally {
      restoreEnv(FORCE_KILL_UNKNOWN_OWNER_ENV_VAR, previous);
    }
  });

  it("stops a legacy lock holder when the operator sets the opt-in env var", () => {
    const previous = process.env[FORCE_KILL_UNKNOWN_OWNER_ENV_VAR];
    try {
      process.env[FORCE_KILL_UNKNOWN_OWNER_ENV_VAR] = "1";
      const result = runLockAcquisition({
        workspaceRoot: "/tmp/test-ws-force-legacy-optin",
        lockContents: "4321",
      });
      assert.strictEqual(result.exitCode, null);
      assert.ok(result.signalsSent.includes("SIGTERM"));
      assert.strictEqual(parseDaemonLockState(result.writes.at(-1))?.pid, process.pid);
    } finally {
      restoreEnv(FORCE_KILL_UNKNOWN_OWNER_ENV_VAR, previous);
    }
  });

  it("still refuses a stale-looking legacy lock without --force", () => {
    const result = runLockAcquisition({
      workspaceRoot: "/tmp/test-ws-noforce",
      lockContents: "4321",
      force: false,
    });
    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(result.signalsSent, []);
  });

  it("takes over a legacy identity-less handoff lock during an auto-update restart", async () => {
    // Mixed-version upgrade: the outgoing daemon ran an older CLI and wrote a
    // handoff lock with no identity. The handoff token is the positive
    // same-instance signal, so takeover must still work.
    let lockContents = JSON.stringify({
      pid: 54321,
      handoff_from_pid: 54321,
      handoff_token: "legacy-handoff-token",
      handoff_expires_at: Date.now() + 5_000,
    });
    const writes = [];
    const killCalls = [];
    let exitCode = null;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-ws-legacy-handoff",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "legacy-handoff",
        LOCK_HANDOFF_TOKEN: "legacy-handoff-token",
        LOCK_HANDOFF_FROM_PID: 54321,
      },
      {
        spawn: () => ({ on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } }),
        mkdirSync: () => {},
        writeFileSync: (_filePath, contents) => {
          lockContents = String(contents);
          writes.push(String(contents));
        },
        existsSync: (filePath) =>
          String(filePath).endsWith("daemon.pid") && lockContents !== null,
        readFileSync: () => lockContents,
        unlinkSync: () => {
          lockContents = null;
        },
        renameSync: () => {},
        createWriteStream: () => ({ write: () => {}, end: () => {} }),
        fetch: async () => ({ ok: true, json: async () => [] }),
        exit: (code) => {
          exitCode = code;
        },
        kill: (pid, signal) => {
          killCalls.push([pid, signal]);
        },
        createWebSocketClient: () => ({
          registerHandler: () => {},
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    daemonInstance.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(exitCode, null);
    assert.deepStrictEqual(killCalls, []);
    const written = parseDaemonLockState(writes.at(-1));
    assert.strictEqual(written.pid, process.pid);
    // The daemon that took over now publishes its own identity.
    assert.ok(written.instanceId);
  });
});

describe("conductor-daemon --nohup preflight", () => {
  const runPreflight = (args, env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [DAEMON_BIN, ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  const withFixture = async (lockBuilder, fn) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-lock-preflight-"));
    const workspaceRoot = path.join(root, "ws");
    const conductorHome = path.join(root, "home");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(conductorHome, { recursive: true });

    // A real, live process to stand in for "the other daemon". If the preflight
    // ever regressed into killing it, this assertion would catch it.
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      fs.writeFileSync(
        path.join(workspaceRoot, "daemon.pid"),
        lockBuilder({ pid: victim.pid, workspaceRoot, conductorHome }),
      );
      const result = await fn({
        env: { CONDUCTOR_WS: workspaceRoot, CONDUCTOR_HOME: conductorHome },
        victim,
        workspaceRoot,
        conductorHome,
      });
      assert.strictEqual(victim.killed, false);
      assert.strictEqual(process.kill(victim.pid, 0), true, "other daemon must still be alive");
      return result;
    } finally {
      victim.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it("detects an identity-bearing lock without --force instead of starting a second daemon", async () => {
    await withFixture(
      ({ pid, workspaceRoot, conductorHome }) =>
        serializeDaemonLock({
          pid,
          identity: buildDaemonInstanceIdentity({
            ...INSTANCE_B,
            workspaceRoot,
            conductorHome,
          }),
        }),
      async ({ env, victim }) => {
        const { code, stderr } = await runPreflight(["--nohup"], env);
        assert.strictEqual(code, 1);
        assert.match(stderr, new RegExp(`existing daemon \\(PID ${victim.pid}\\)`));
      },
    );
  });

  it("refuses --nohup --force when the lock belongs to a different instance", async () => {
    await withFixture(
      ({ pid, workspaceRoot }) =>
        serializeDaemonLock({
          pid,
          identity: buildDaemonInstanceIdentity({ ...INSTANCE_A, workspaceRoot }),
        }),
      async ({ env }) => {
        const { code, stderr } = await runPreflight(["--nohup", "--force"], env);
        assert.strictEqual(code, 1);
        assert.match(stderr, /different Conductor instance/);
        assert.match(stderr, /alice-box/);
      },
    );
  });

  it("refuses --nohup --force against a legacy identity-less lock", async () => {
    await withFixture(
      ({ pid }) => String(pid),
      async ({ env }) => {
        const { code, stderr } = await runPreflight(["--nohup", "--force"], {
          ...env,
          [FORCE_KILL_UNKNOWN_OWNER_ENV_VAR]: "",
        });
        assert.strictEqual(code, 1);
        assert.match(stderr, /no instance identity/);
      },
    );
  });
});
