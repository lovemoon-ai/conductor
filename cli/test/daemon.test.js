import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import {
  ensureNodePtySpawnHelperExecutable,
  probePtyTaskCapability,
  resolveDefaultPtyShell,
  startDaemon,
} from "../src/daemon.js";
import { resetRuntimeBackendCacheForTests } from "../src/runtime-backends.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "..", "modules", "ai-sdk", "fixtures", "fake-external-provider.js");

function restoreEnv(key, value) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function expectEvent(events, type, assertPayload) {
  const event = events.find((entry) => entry.type === type);
  assert.ok(event, `expected event ${type}`);
  assertPayload(event.payload);
}

describe("Daemon", () => {
  let wss;
  let daemon;
  let port;

  before(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => wss.on("listening", resolve));
    port = wss.address().port;
  });

  after(() => {
    if (daemon) daemon.close();
    if (wss) wss.close();
  });

  it("marks node-pty spawn-helper executable before PTY spawn", () => {
    const packageJsonPath = "/tmp/node_modules/node-pty/package.json";
    const helperPath = path.join(
      "/tmp/node_modules/node-pty",
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );
    const chmodCalls = [];

    const result = ensureNodePtySpawnHelperExecutable({
      platform: "darwin",
      arch: "arm64",
      packageJsonPath,
      existsSync: (candidate) => candidate === helperPath,
      statSync: (candidate) => {
        assert.strictEqual(candidate, helperPath);
        return { mode: 0o100644 };
      },
      chmodSync: (candidate, mode) => {
        chmodCalls.push([candidate, mode]);
      },
    });

    assert.deepStrictEqual(result, { helperPath, updated: true });
    assert.deepStrictEqual(chmodCalls, [[helperPath, 0o755]]);
  });

  it("falls back to /bin/bash for PTY tasks on linux when SHELL is unset", () => {
    const previousShell = process.env.SHELL;
    try {
      delete process.env.SHELL;
      assert.strictEqual(
        resolveDefaultPtyShell({
          platform: "linux",
          existsSync: (candidate) => candidate === "/bin/bash",
        }),
        "/bin/bash",
      );
    } finally {
      restoreEnv("SHELL", previousShell);
    }
  });

  it("falls back to /bin/sh for PTY tasks on linux when bash is unavailable", () => {
    const previousShell = process.env.SHELL;
    try {
      delete process.env.SHELL;
      assert.strictEqual(
        resolveDefaultPtyShell({
          platform: "linux",
          existsSync: (candidate) => candidate === "/bin/sh",
        }),
        "/bin/sh",
      );
    } finally {
      restoreEnv("SHELL", previousShell);
    }
  });

  it("disables PTY capability when node-pty cannot be loaded at startup", () => {
    const capability = probePtyTaskCapability({
      ensureSpawnHelperExecutableFn: () => null,
      requireFn: () => {
        throw new Error("Failed to load native module: pty.node");
      },
    });

    assert.deepStrictEqual(capability, {
      enabled: false,
      reason: "Failed to load native module: pty.node",
      spawnHelperInfo: null,
      spawnPty: null,
    });
  });

  it("reports PTY capability when node-pty exposes spawn at startup", () => {
    const spawnPty = () => {};
    const capability = probePtyTaskCapability({
      ensureSpawnHelperExecutableFn: () => ({ helperPath: "/tmp/spawn-helper", updated: false }),
      requireFn: () => ({ spawn: spawnPty }),
    });

    assert.strictEqual(capability.enabled, true);
    assert.strictEqual(capability.reason, null);
    assert.deepStrictEqual(capability.spawnHelperInfo, {
      helperPath: "/tmp/spawn-helper",
      updated: false,
    });
    assert.strictEqual(capability.spawnPty, spawnPty);
  });

  it("skips auto-update for local installs by default", async () => {
    const previousWatchdogInterval = process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS;
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";

    let versionChecks = 0;
    let installAttempts = 0;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-auto-update-local",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-auto-update-local",
      },
      {
        spawn: () => {
          installAttempts += 1;
          return {
            pid: 1,
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("unexpected read");
        },
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({ write: () => {}, end: () => {} }),
        fetch: async () => ({ ok: true, json: async () => [] }),
        fetchLatestVersion: async () => {
          versionChecks += 1;
          return "0.2.21";
        },
        isNewerVersion: () => true,
        isManagedInstallPath: () => false,
        createWebSocketClient: () => ({
          registerHandler: () => {},
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 35));
    daemonInstance.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", previousWatchdogInterval);
    assert.strictEqual(versionChecks, 0);
    assert.strictEqual(installAttempts, 0);
  });

  it("verifies and restarts auto-update through the same launcher script", async () => {
    const previousWatchdogInterval = process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS;
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";

    let installAttempts = 0;
    let rebuildAttempts = 0;
    let rootLookups = 0;
    let nodePtyVerificationAttempts = 0;
    let versionChecks = 0;
    let restartAttempts = 0;
    let exitCode = null;
    let packageManagerOptions = null;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-auto-update-install",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-auto-update-install",
        RESTART_LAUNCHER_SCRIPT: "/mock/bin/conductor",
        RESTART_LAUNCHER_ARGS: ["daemon", "--config-file", "/tmp/config.yaml"],
        VERSION_CHECK_SCRIPT: "/mock/bin/conductor",
        VERSION_CHECK_ARGS: ["--version"],
      },
      {
        spawn: (cmd, args, opts) => {
          if (cmd === "npm") {
            if (args[0] === "install") {
              installAttempts += 1;
              assert.deepStrictEqual(args, [
                "install",
                "-g",
                "@love-moon/conductor-cli@0.2.21",
              ]);
            } else if (args[0] === "rebuild") {
              rebuildAttempts += 1;
              assert.deepStrictEqual(args, [
                "rebuild",
                "-g",
                "@love-moon/conductor-cli",
              ]);
            } else if (args[0] === "root") {
              rootLookups += 1;
            } else {
              throw new Error(`unexpected npm command: ${args.join(" ")}`);
            }
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            if (args[0] === "root") {
              setImmediate(() => {
                child.stdout.emit("data", "/mock/global/node_modules\n");
                child.emit("close", 0);
              });
            } else {
              setImmediate(() => child.emit("close", 0));
            }
            return child;
          }
          if (cmd === process.execPath && args[0] === "/mock/bin/conductor" && args[1] === "--version") {
            versionChecks += 1;
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => {
              child.stdout.emit("data", "conductor version 0.2.21 (test)\n");
              child.emit("close", 0);
            });
            return child;
          }
          if (cmd === process.execPath && args[0] === "-e") {
            nodePtyVerificationAttempts += 1;
            assert.match(args[1], /node-pty/);
            assert.strictEqual(args[2], "/mock/global/node_modules/@love-moon/conductor-cli");
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          if (
            cmd === process.execPath &&
            args[0] === "/mock/bin/conductor" &&
            args[1] === "daemon"
          ) {
            restartAttempts += 1;
            assert.deepStrictEqual(args, [
              "/mock/bin/conductor",
              "daemon",
              "--config-file",
              "/tmp/config.yaml",
            ]);
            assert.ok(opts?.env?.CONDUCTOR_LOCK_HANDOFF_TOKEN);
            assert.strictEqual(opts?.env?.CONDUCTOR_LOCK_HANDOFF_FROM_PID, String(process.pid));
            assert.ok(Number(opts?.env?.CONDUCTOR_LOCK_HANDOFF_EXPIRES_AT) > Date.now());
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            child.unref = () => {};
            child.pid = 43210;
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          throw new Error(`unexpected spawn: ${cmd} ${args.join(" ")}`);
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("unexpected read");
        },
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({ write: () => {}, end: () => {} }),
        fetch: async () => ({ ok: true, json: async () => [] }),
        fetchLatestVersion: async () => "0.2.21",
        isNewerVersion: () => true,
        detectPackageManager: (options) => {
          packageManagerOptions = options;
          return "npm";
        },
        isInUpdateWindow: () => true,
        isManagedInstallPath: () => true,
        isBackgroundProcess: true,
        cliVersion: "0.2.20",
        exit: (code) => {
          exitCode = code;
        },
        createWebSocketClient: () => ({
          registerHandler: () => {},
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    daemonInstance.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", previousWatchdogInterval);
    assert.strictEqual(installAttempts, 1);
    assert.strictEqual(rebuildAttempts, 1);
    assert.strictEqual(rootLookups, 1);
    assert.strictEqual(nodePtyVerificationAttempts, 1);
    assert.strictEqual(versionChecks, 1);
    assert.strictEqual(restartAttempts, 1);
    assert.strictEqual(packageManagerOptions?.launcherPath, "/mock/bin/conductor");
    assert.match(packageManagerOptions?.packageRoot || "", /\/cli$/);
    assert.strictEqual(exitCode, 0);
  });

  it("forces process exit when auto-update restart fails after shutdown", async () => {
    const previousWatchdogInterval = process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS;
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";

    let exitCode = null;
    let restartAttempts = 0;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-auto-update-restart-fail",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-auto-update-restart-fail",
        RESTART_LAUNCHER_SCRIPT: "/mock/bin/conductor",
        RESTART_LAUNCHER_ARGS: ["daemon"],
        VERSION_CHECK_SCRIPT: "/mock/bin/conductor",
        VERSION_CHECK_ARGS: ["--version"],
      },
      {
        spawn: (cmd, args) => {
          if (cmd === "npm") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            if (args[0] === "root") {
              setImmediate(() => {
                child.stdout.emit("data", "/mock/global/node_modules\n");
                child.emit("close", 0);
              });
            } else {
              setImmediate(() => child.emit("close", 0));
            }
            return child;
          }
          if (cmd === process.execPath && args[0] === "/mock/bin/conductor" && args[1] === "--version") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => {
              child.stdout.emit("data", "conductor version 0.2.21 (test)\n");
              child.emit("close", 0);
            });
            return child;
          }
          if (cmd === process.execPath && args[0] === "-e") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          if (cmd === process.execPath && args[0] === "/mock/bin/conductor" && args[1] === "daemon") {
            restartAttempts += 1;
            throw new Error("spawn failed");
          }
          throw new Error(`unexpected spawn: ${cmd} ${args.join(" ")}`);
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("unexpected read");
        },
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({ write: () => {}, end: () => {} }),
        fetch: async () => ({ ok: true, json: async () => [] }),
        fetchLatestVersion: async () => "0.2.21",
        isNewerVersion: () => true,
        detectPackageManager: () => "npm",
        isInUpdateWindow: () => true,
        isManagedInstallPath: () => true,
        isBackgroundProcess: true,
        cliVersion: "0.2.20",
        exit: (code) => {
          exitCode = code;
        },
        createWebSocketClient: () => ({
          registerHandler: () => {},
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    daemonInstance.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", previousWatchdogInterval);
    assert.strictEqual(restartAttempts, 1);
    assert.strictEqual(exitCode, 1);
  });

  it("prepares pnpm build approval before auto-update installs node-pty", async () => {
    const previousWatchdogInterval = process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS;
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";

    const calls = [];
    let builtDependenciesJson = '"foo"';
    let exitCode = null;
    let restartAttempts = 0;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-auto-update-pnpm",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-auto-update-pnpm",
        RESTART_LAUNCHER_SCRIPT: "/mock/bin/conductor",
        RESTART_LAUNCHER_ARGS: ["daemon"],
        VERSION_CHECK_SCRIPT: "/mock/bin/conductor",
        VERSION_CHECK_ARGS: ["--version"],
      },
      {
        spawn: (cmd, args, options = {}) => {
          calls.push([cmd, args, options]);
          if (cmd === "pnpm" && args[0] === "config" && args[1] === "get") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => {
              child.stdout.emit("data", builtDependenciesJson);
              child.emit("close", 0);
            });
            return child;
          }
          if (cmd === "pnpm" && args[0] === "config" && args[1] === "set") {
            builtDependenciesJson = args[4];
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          if (cmd === "pnpm" && args[0] === "add") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          if (cmd === "pnpm" && args[0] === "rebuild") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          if (cmd === "pnpm" && args[0] === "root") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => {
              child.stdout.emit("data", "/mock/pnpm/global/node_modules\n");
              child.emit("close", 0);
            });
            return child;
          }
          if (cmd === process.execPath && args[0] === "/mock/bin/conductor" && args[1] === "--version") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => {
              child.stdout.emit("data", "conductor version 0.2.21 (test)\n");
              child.emit("close", 0);
            });
            return child;
          }
          if (cmd === process.execPath && args[0] === "-e") {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          if (cmd === process.execPath && args[0] === "/mock/bin/conductor" && args[1] === "daemon") {
            restartAttempts += 1;
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            child.unref = () => {};
            child.pid = 43211;
            setImmediate(() => child.emit("close", 0));
            return child;
          }
          throw new Error(`unexpected spawn: ${cmd} ${args.join(" ")}`);
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("unexpected read");
        },
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({ write: () => {}, end: () => {} }),
        fetch: async () => ({ ok: true, json: async () => [] }),
        fetchLatestVersion: async () => "0.2.21",
        isNewerVersion: () => true,
        detectPackageManager: () => "pnpm",
        isInUpdateWindow: () => true,
        isManagedInstallPath: () => true,
        isBackgroundProcess: true,
        cliVersion: "0.2.20",
        exit: (code) => {
          exitCode = code;
        },
        createWebSocketClient: () => ({
          registerHandler: () => {},
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    daemonInstance.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", previousWatchdogInterval);
    assert.deepStrictEqual(
      calls
        .filter(([cmd]) => cmd === "pnpm")
        .slice(0, 5)
        .map(([cmd, args]) => [cmd, args]),
      [
        ["pnpm", ["config", "get", "--global", "onlyBuiltDependencies", "--json"]],
        ["pnpm", ["config", "set", "--global", "onlyBuiltDependencies", '["foo","node-pty"]']],
        ["pnpm", ["add", "-g", "@love-moon/conductor-cli@0.2.21"]],
        ["pnpm", ["config", "get", "--global", "onlyBuiltDependencies", "--json"]],
        ["pnpm", ["root", "-g"]],
      ],
    );
    const rebuildCall = calls.find(
      ([cmd, args]) => cmd === "pnpm" && Array.isArray(args) && args[0] === "rebuild",
    );
    assert.ok(rebuildCall);
    assert.deepStrictEqual(rebuildCall[0], "pnpm");
    assert.deepStrictEqual(rebuildCall[1], ["rebuild", "node-pty"]);
    assert.strictEqual(rebuildCall[2]?.cwd, "/mock/pnpm/global/node_modules/@love-moon/conductor-cli");
    assert.strictEqual(restartAttempts, 1);
    assert.strictEqual(exitCode, 0);
  });

  it("allows lock takeover when restart handoff token matches the existing daemon lock", async () => {
    let exitCode = null;
    let lockContents = JSON.stringify({
      pid: 54321,
      handoff_from_pid: 54321,
      handoff_token: "handoff-token",
      handoff_expires_at: Date.now() + 5_000,
    });
    const writeCalls = [];
    const killCalls = [];

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-auto-update-handoff",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-auto-update-handoff",
        LOCK_HANDOFF_TOKEN: "handoff-token",
        LOCK_HANDOFF_FROM_PID: 54321,
      },
      {
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: (_filePath, value) => {
          lockContents = value;
          writeCalls.push(value);
        },
        existsSync: (filePath) => filePath.endsWith("daemon.pid") && lockContents !== null,
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
    assert.strictEqual(writeCalls.at(-1), String(process.pid));
    assert.deepStrictEqual(killCalls, []);
  });

  it("should connect and spawn process on create_task", (t, done) => {
    const taskPayload = {
      task_id: "task-1",
      project_id: "proj-1",
      backend_type: "codex",
      initial_content: "hello",
    };

    let spawned = false;
    let mkdirCalled = false;
    let renameCalled = false;
    let spawnedCwd = "";

    const mockSpawn = (_cmd, args, opts) => {
      spawnedCwd = opts.cwd;
      assert.match(
        opts.cwd,
        /^\/tmp\/test-ws\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_\d+$/,
      );
      assert.ok(args.includes("--backend"));
      assert.ok(args.includes("codex"));
      assert.ok(args.includes("--prefill"));
      assert.ok(args.includes("hello"));
      assert.strictEqual(args[args.length - 1], "--");
      spawned = true;
      return {
        pid: 24680,
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      };
    };

    const mockMkdir = (dirPath) => {
      if (dirPath === "/tmp/test-ws") return undefined;
      assert.match(
        dirPath,
        /^\/tmp\/test-ws\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_\d+$/,
      );
      mkdirCalled = true;
      return undefined;
    };

    const mockWriteFile = (filePath) => {
      if (filePath.endsWith("daemon.pid")) return;
      throw new Error(`Unexpected write to ${filePath}`);
    };

    const mockExists = (filePath) => {
      if (filePath.endsWith("daemon.pid")) return false;
      return false;
    };

    const mockReadFile = (filePath) => {
      throw new Error(`Unexpected read from ${filePath}`);
    };

    const mockUnlink = (filePath) => {
      if (filePath.endsWith("daemon.pid")) return;
      throw new Error(`Unexpected unlink of ${filePath}`);
    };

    const mockCreateWriteStream = (filePath) => {
      assert.match(
        filePath,
        /^\/tmp\/test-ws\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_24680\/conductor\.log$/,
      );
      return {
        write: () => {},
        end: () => {},
      };
    };

    const mockRename = (fromPath, toPath) => {
      assert.strictEqual(fromPath, spawnedCwd);
      assert.match(
        toPath,
        /^\/tmp\/test-ws\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_24680$/,
      );
      renameCalled = true;
    };

    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "create_task",
          payload: taskPayload,
        }),
      );
    });

    daemon = startDaemon(
      {
        BACKEND_URL: `ws://localhost:${port}`,
        WORKSPACE_ROOT: "/tmp/test-ws",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-test",
      },
      {
        spawn: mockSpawn,
        mkdirSync: mockMkdir,
        writeFileSync: mockWriteFile,
        existsSync: mockExists,
        readFileSync: mockReadFile,
        unlinkSync: mockUnlink,
        renameSync: mockRename,
        createWriteStream: mockCreateWriteStream,
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
      },
    );

    setTimeout(() => {
      assert.strictEqual(spawned, true);
      assert.strictEqual(mkdirCalled, true);
      assert.strictEqual(renameCalled, true);
      if (daemon && typeof daemon.close === "function") {
        daemon.close();
        daemon = null;
      }
      done();
    }, 500);
  });

  it("rejects legacy backend aliases from create_task", (t, done) => {
    const taskPayload = {
      task_id: "task-alias-1",
      project_id: "proj-alias-1",
      backend_type: "code",
      initial_content: "hello",
    };

    let spawned = false;
    const sentEvents = [];

    const noopStream = () => ({
      write: () => {},
      end: () => {},
    });

    wss.once("connection", (ws) => {
      ws.on("message", (raw) => {
        sentEvents.push(JSON.parse(String(raw)));
      });
      ws.send(
        JSON.stringify({
          type: "create_task",
          payload: taskPayload,
        }),
      );
    });

    daemon = startDaemon(
      {
        BACKEND_URL: `ws://localhost:${port}`,
        WORKSPACE_ROOT: "/tmp/test-ws-alias",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-alias",
      },
      {
        spawn: () => {
          spawned = true;
          return {
            pid: 24681,
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("unexpected read");
        },
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: noopStream,
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
      },
    );

    setTimeout(() => {
      assert.equal(spawned, false);
      assert.equal(
        sentEvents.some(
          (entry) =>
            entry?.type === "task_status_update" &&
            entry?.payload?.task_id === "task-alias-1" &&
            entry?.payload?.summary === "Unsupported backend: code",
        ),
        true,
      );
      daemon.close();
      done();
    }, 300);
  });

  it("advertises and launches external backends on daemon hosts", async (t) => {
    const previousProviderPath = process.env.AISDK_PROVIDER_PATH;
    process.env.AISDK_PROVIDER_PATH = FIXTURE_EXTERNAL_PROVIDER;
    resetRuntimeBackendCacheForTests();

    let handler;
    let webSocketClientOptions;
    const spawnCalls = [];
    const sentEvents = [];
    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-ws-external-backend",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-external-backend",
      },
      {
        spawn: (cmd, args, options) => {
          spawnCalls.push({ cmd, args, options });
          return {
            pid: 24682,
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: fs.existsSync,
        readFileSync: fs.readFileSync,
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/projects/proj-external-1")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_config, options) => {
          webSocketClientOptions = options;
          return {
            registerHandler: (registeredHandler) => {
              handler = registeredHandler;
            },
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async (payload) => {
              sentEvents.push(payload);
            },
          };
        },
      },
    );

    t.after(() => {
      if (previousProviderPath === undefined) {
        delete process.env.AISDK_PROVIDER_PATH;
      } else {
        process.env.AISDK_PROVIDER_PATH = previousProviderPath;
      }
      resetRuntimeBackendCacheForTests();
      if (daemonInstance && typeof daemonInstance.close === "function") {
        daemonInstance.close();
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.ok(typeof handler === "function");
    assert.ok(String(webSocketClientOptions.extraHeaders["x-conductor-backends"]).includes("test-external"));

    handler({
      type: "create_task",
      payload: {
        task_id: "task-external-1",
        project_id: "proj-external-1",
        backend_type: "test-external-alias",
        request_id: "req-external-1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0].args.slice(0, 4), [
      "/tmp/cli.js",
      "--backend",
      "test-external",
      "--",
    ]);
    assert.strictEqual(spawnCalls[0].options.env.CONDUCTOR_LAUNCHED_BY_DAEMON, "1");
    assert.strictEqual(spawnCalls[0].options.env.CONDUCTOR_CLI_COMMAND, undefined);
    assert.equal(
      sentEvents.some(
        (entry) =>
          entry?.type === "task_status_update" &&
          entry?.payload?.task_id === "task-external-1" &&
          entry?.payload?.status === "RUNNING",
      ),
      true,
    );
  });

  it("should not spawn duplicate fire processes for the same task_id", (t, done) => {
    const taskPayload = {
      task_id: "task-dup",
      project_id: "proj-dup",
      backend_type: "codex",
    };
    let spawnCount = 0;

    const mockSpawn = () => {
      spawnCount += 1;
      return {
        pid: 51000 + spawnCount,
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      };
    };

    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "create_task",
          payload: { ...taskPayload, request_id: "req-dup-1" },
        }),
      );
      ws.send(
        JSON.stringify({
          type: "create_task",
          payload: { ...taskPayload, request_id: "req-dup-2" },
        }),
      );
    });

    daemon = startDaemon(
      {
        BACKEND_URL: `ws://localhost:${port}`,
        WORKSPACE_ROOT: "/tmp/test-ws-dup",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-dup",
      },
      {
        spawn: mockSpawn,
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async () => ({ ok: true, json: async () => [] }),
      },
    );

    setTimeout(() => {
      assert.strictEqual(spawnCount, 1);
      if (daemon && typeof daemon.close === "function") {
        daemon.close();
        daemon = null;
      }
      done();
    }, 500);
  });

  it("clears pending create_task state after a pre-spawn failure", async (t) => {
    const sentEvents = [];
    const unhandledRejections = [];
    let handler;
    let spawnCount = 0;
    let failWorkspaceCreate = true;
    const onUnhandledRejection = (error) => {
      unhandledRejections.push(error);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-ws-create-failure",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "daemon-create-failure",
      },
      {
        spawn: () => {
          spawnCount += 1;
          return {
            pid: 24683,
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: (targetPath) => {
          if (String(targetPath).startsWith("/tmp/test-ws-create-failure/") && failWorkspaceCreate) {
            failWorkspaceCreate = false;
            throw new Error("workspace mkdir failed");
          }
        },
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/projects/proj-create-failure-1")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (registeredHandler) => {
            handler = registeredHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    t.after(() => {
      process.off("unhandledRejection", onUnhandledRejection);
      if (daemonInstance && typeof daemonInstance.close === "function") {
        daemonInstance.close();
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(typeof handler === "function");

    handler({
      type: "create_task",
      payload: {
        task_id: "task-create-failure-1",
        project_id: "proj-create-failure-1",
        backend_type: "codex",
        request_id: "req-create-failure-1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.strictEqual(spawnCount, 0);
    assert.deepStrictEqual(unhandledRejections, []);
    assert.equal(
      sentEvents.some(
        (entry) =>
          entry?.type === "task_status_update" &&
          entry?.payload?.task_id === "task-create-failure-1" &&
          entry?.payload?.status === "KILLED" &&
          String(entry?.payload?.summary || "").includes("workspace mkdir failed"),
      ),
      true,
    );

    handler({
      type: "create_task",
      payload: {
        task_id: "task-create-failure-1",
        project_id: "proj-create-failure-1",
        backend_type: "codex",
        request_id: "req-create-failure-2",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.strictEqual(spawnCount, 1);
  });

  it("falls back to default workspace when project path lookup times out", (t, done) => {
    const previousTimeout = process.env.CONDUCTOR_PROJECT_PATH_LOOKUP_TIMEOUT_MS;
    process.env.CONDUCTOR_PROJECT_PATH_LOOKUP_TIMEOUT_MS = "20";
    t.after(() => {
      if (previousTimeout === undefined) {
        delete process.env.CONDUCTOR_PROJECT_PATH_LOOKUP_TIMEOUT_MS;
      } else {
        process.env.CONDUCTOR_PROJECT_PATH_LOOKUP_TIMEOUT_MS = previousTimeout;
      }
    });

    const taskPayload = {
      task_id: "task-timeout",
      project_id: "proj-timeout",
      backend_type: "codex",
    };

    let spawned = false;
    let renameCalled = false;
    let spawnedCwd = "";

    const mockFetch = (url, options) => {
      if (String(url).includes("/api/projects/")) {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) });
    };

    const mockSpawn = (_cmd, _args, opts) => {
      spawnedCwd = opts.cwd;
      assert.match(
        opts.cwd,
        /^\/tmp\/test-ws-timeout\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_\d+$/,
      );
      spawned = true;
      return {
        pid: 35791,
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      };
    };

    const mockRename = (fromPath, toPath) => {
      assert.strictEqual(fromPath, spawnedCwd);
      assert.match(
        toPath,
        /^\/tmp\/test-ws-timeout\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_35791$/,
      );
      renameCalled = true;
    };

    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "create_task",
          payload: taskPayload,
        }),
      );
    });

    daemon = startDaemon(
      {
        BACKEND_URL: `ws://localhost:${port}`,
        WORKSPACE_ROOT: "/tmp/test-ws-timeout",
        CLI_PATH: "/tmp/cli.js",
        NAME: "daemon-timeout",
      },
      {
        spawn: mockSpawn,
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: mockRename,
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: mockFetch,
      },
    );

    setTimeout(() => {
      assert.strictEqual(spawned, true);
      assert.strictEqual(renameCalled, true);
      if (daemon && typeof daemon.close === "function") {
        daemon.close();
        daemon = null;
      }
      done();
    }, 500);
  });

  it("expands tilde workspace root to HOME path", (t, done) => {
    const taskPayload = {
      task_id: "task-tilde",
      project_id: "proj-tilde",
      backend_type: "codex",
    };

    const expectedRoot = path.join(process.env.HOME || "/tmp", "ws", "fires");
    let rootDirCreated = false;
    let spawned = false;
    let renameCalled = false;
    let spawnedCwd = "";

    const mockSpawn = (_cmd, _args, opts) => {
      spawnedCwd = opts.cwd;
      assert.ok(opts.cwd.startsWith(`${expectedRoot}/`));
      assert.match(
        opts.cwd.slice(expectedRoot.length + 1),
        /^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_\d+$/,
      );
      spawned = true;
      return {
        pid: 60123,
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      };
    };

    const mockMkdir = (dirPath) => {
      if (dirPath === expectedRoot) {
        rootDirCreated = true;
        return;
      }
      assert.ok(dirPath.startsWith(`${expectedRoot}/`));
      assert.match(
        dirPath.slice(expectedRoot.length + 1),
        /^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_\d+$/,
      );
    };

    const mockRename = (fromPath, toPath) => {
      assert.strictEqual(fromPath, spawnedCwd);
      assert.ok(toPath.startsWith(`${expectedRoot}/`));
      assert.match(
        toPath.slice(expectedRoot.length + 1),
        /^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pid_60123$/,
      );
      renameCalled = true;
    };

    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "create_task",
          payload: taskPayload,
        }),
      );
    });

    daemon = startDaemon(
      {
        BACKEND_URL: `ws://localhost:${port}`,
        WORKSPACE_ROOT: "~/ws/fires",
        CLI_PATH: "/tmp/cli.js",
        NAME: "daemon-tilde",
      },
      {
        spawn: mockSpawn,
        mkdirSync: mockMkdir,
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: mockRename,
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
      },
    );

    setTimeout(() => {
      assert.strictEqual(rootDirCreated, true);
      assert.strictEqual(spawned, true);
      assert.strictEqual(renameCalled, true);
      if (daemon && typeof daemon.close === "function") {
        daemon.close();
        daemon = null;
      }
      done();
    }, 500);
  });

  it("uses metadata.localPaths.default when daemon-specific path is missing", (t, done) => {
    const taskPayload = {
      task_id: "task-default-path",
      project_id: "proj-default-path",
      backend_type: "codex",
    };

    let spawned = false;
    let renameCalled = false;

    const mockFetch = async (url) => {
      if (String(url).includes("/api/projects/")) {
        return {
          ok: true,
          json: async () => ({
            id: "proj-default-path",
            metadata: {
              localPaths: {
                default: "/tmp/bound-project",
              },
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ removed: 0, remaining: 0 }) };
    };

    const mockSpawn = (_cmd, _args, opts) => {
      assert.strictEqual(opts.cwd, "/tmp/bound-project");
      spawned = true;
      return {
        pid: 48321,
        on: () => {},
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      };
    };

    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "create_task",
          payload: taskPayload,
        }),
      );
    });

    daemon = startDaemon(
      {
        BACKEND_URL: `ws://localhost:${port}`,
        WORKSPACE_ROOT: "/tmp/test-ws-default-path",
        CLI_PATH: "/tmp/cli.js",
        NAME: "daemon-without-bound-key",
      },
      {
        spawn: mockSpawn,
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {
          renameCalled = true;
        },
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: mockFetch,
      },
    );

    setTimeout(() => {
      assert.strictEqual(spawned, true);
      assert.strictEqual(renameCalled, false);
      if (daemon && typeof daemon.close === "function") {
        daemon.close();
        daemon = null;
      }
      done();
    }, 500);
  });

  it("cleans all and exits", async () => {
    let exited = false;
    let exitResolve;
    const exitPromise = new Promise((resolve) => {
      exitResolve = resolve;
    });
    const mockFetch = async (url, options) => {
      assert.ok(url.includes("/agents/cleanup"));
      assert.strictEqual(options.method, "GET");
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ removed: 2, remaining: 0 }) };
    };
    const mockExit = (code) => {
      exited = code;
      exitResolve();
    };

    startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws",
        CLI_PATH: "/tmp/cli.js",
        NAME: "clean-daemon",
        CLEAN_ALL: true,
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: mockFetch,
        exit: mockExit,
      },
    );

    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 200))]);
    assert.strictEqual(exited, 0);
  });

  it("exits early when lock exists and daemon is running without --force", () => {
    let exitCode = null;
    let writeCalled = false;
    let sigtermCalled = false;

    const kill = (_pid, signal) => {
      if (signal === 0) {
        return;
      }
      if (signal === "SIGTERM") {
        sigtermCalled = true;
        return;
      }
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-ws-lock-running",
        CLI_PATH: "/tmp/cli.js",
        NAME: "lock-running",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called");
        },
        mkdirSync: () => {},
        writeFileSync: () => {
          writeCalled = true;
        },
        existsSync: (filePath) => filePath.endsWith("daemon.pid"),
        readFileSync: () => "123",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
        exit: (code) => {
          exitCode = code;
        },
        kill,
      },
    );
    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(writeCalled, false);
    assert.strictEqual(sigtermCalled, false);
  });

  it("forces restart by stopping existing daemon when --force is set", () => {
    let exitCode = null;
    let writeCalled = false;
    let unlinkCalled = false;
    const killCalls = [];
    let killed = false;

    const kill = (_pid, signal) => {
      killCalls.push(signal);
      if (signal === 0) {
        if (killed) {
          const err = new Error("process not found");
          err.code = "ESRCH";
          throw err;
        }
        return;
      }
      if (signal === "SIGTERM") {
        killed = true;
      }
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-ws-lock-force",
        CLI_PATH: "/tmp/cli.js",
        NAME: "lock-force",
        FORCE: true,
      },
      {
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {
          writeCalled = true;
        },
        existsSync: (filePath) => filePath.endsWith("daemon.pid"),
        readFileSync: () => "456",
        unlinkSync: () => {
          unlinkCalled = true;
        },
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
        exit: (code) => {
          exitCode = code;
        },
        kill,
      },
    );
    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }

    assert.strictEqual(exitCode, null);
    assert.strictEqual(unlinkCalled, true);
    assert.strictEqual(writeCalled, true);
    assert.deepStrictEqual(killCalls, [0, "SIGTERM", 0]);
  });

  it("stops running child process when stop_task is received", async () => {
    let handler;
    let childExitHandler = null;
    const killCalls = [];

    const child = {
      pid: 77777,
      kill: (signal) => {
        killCalls.push(signal);
      },
      on: (eventName, fn) => {
        if (eventName === "exit") {
          childExitHandler = fn;
        }
      },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-stop-task",
        CLI_PATH: "/tmp/cli.js",
        NAME: "stop-task-daemon",
      },
      {
        spawn: () => child,
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_config, _options) => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_task",
      payload: {
        task_id: "task-stop-1",
        project_id: "proj-stop-1",
        backend_type: "codex",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    handler({
      type: "stop_task",
      payload: {
        task_id: "task-stop-1",
        reason: "deleted_by_user",
      },
    });

    assert.deepStrictEqual(killCalls, ["SIGTERM"]);

    if (childExitHandler) {
      childExitHandler(143, "SIGTERM");
    }

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("restarts same-backend tasks without calling bridge and skips UNKNOWN before running", async () => {
    let handler;
    const spawnCalls = [];
    const sentEvents = [];
    let bridgeCalls = 0;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-restart-same",
        CLI_PATH: "/tmp/cli.js",
        NAME: "restart-same-daemon",
      },
      {
        spawn: (_cmd, args, opts) => {
          spawnCalls.push({ args, opts });
          return {
            pid: 61234,
            kill: () => {},
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        bridgeSessionBetweenBackends: async () => {
          bridgeCalls += 1;
          throw new Error("bridge should not be called");
        },
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return {
              ok: true,
              json: async () => ({ metadata: { localPaths: { default: "/tmp/restart-same-cwd" } } }),
            };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (nextHandler) => {
            handler = nextHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    handler({
      type: "restart_task",
      payload: {
        mode: "resume_inplace",
        source_task_id: "task-restart-1",
        target_task_id: "task-restart-1",
        project_id: "proj-restart-1",
        title: "Restart same backend",
        source_backend_type: "codex",
        source_session_id: "sess-restart-1",
        target_backend_type: "codex",
        request_id: "req-restart-1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(bridgeCalls, 0);
    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0].args, [
      "/tmp/cli.js",
      "--backend",
      "codex",
      "--resume",
      "sess-restart-1",
      "--",
    ]);
    assert.strictEqual(spawnCalls[0].opts.cwd, "/tmp/restart-same-cwd");
    assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_TASK_ID, "task-restart-1");
    assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_RESUME_CWD, "/tmp/restart-same-cwd");
    expectEvent(sentEvents, "agent_command_ack", (payload) => {
      assert.strictEqual(payload.request_id, "req-restart-1");
      assert.strictEqual(payload.event_type, "restart_task");
      assert.strictEqual(payload.accepted, true);
    });
    expectEvent(sentEvents, "task_status_update", (payload) => {
      assert.strictEqual(payload.task_id, "task-restart-1");
      assert.strictEqual(payload.status, "RUNNING");
    });
    assert.ok(
      !sentEvents.some(
        (entry) =>
          entry.type === "task_status_update"
          && entry.payload?.task_id === "task-restart-1"
          && entry.payload?.status === "UNKNOWN",
      ),
      "did not expect UNKNOWN status during in-place restart",
    );

    daemonInstance.close();
  });

  it("bridges cross-backend restarts and launches the successor task", async () => {
    let handler;
    const spawnCalls = [];
    const bridgeCalls = [];
    const sentEvents = [];

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-restart-bridge",
        CLI_PATH: "/tmp/cli.js",
        NAME: "restart-bridge-daemon",
      },
      {
        spawn: (_cmd, args, opts) => {
          spawnCalls.push({ args, opts });
          return {
            pid: 62345,
            kill: () => {},
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        bridgeSessionBetweenBackends: async (params) => {
          bridgeCalls.push(params);
          return {
            sessionId: "sess-bridged-1",
            cwd: "/tmp/bridged-cwd",
          };
        },
        resolveResumeContext: async () => ({ cwd: "" }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (nextHandler) => {
            handler = nextHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    handler({
      type: "restart_task",
      payload: {
        mode: "fork_to_new_task",
        source_task_id: "task-source-1",
        target_task_id: "task-successor-1",
        project_id: "proj-bridge-1",
        title: "Fix login bug [claude]",
        source_backend_type: "codex",
        source_session_id: "sess-codex-1",
        source_session_file_path: "/tmp/sess-codex-1.jsonl",
        target_backend_type: "claude",
        request_id: "req-bridge-1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expectEvent(sentEvents, "task_status_update", (payload) => {
      assert.strictEqual(payload.task_id, "task-successor-1");
      assert.strictEqual(payload.status, "INIT");
    });
    assert.deepStrictEqual(bridgeCalls, [
      {
        sourceTool: "codex",
        sourceSessionId: "sess-codex-1",
        sourceSessionPath: "/tmp/sess-codex-1.jsonl",
        sourceSessionInfo: {
          tool: "codex",
          sessionId: "sess-codex-1",
          path: "/tmp/sess-codex-1.jsonl",
          cwd: undefined,
        },
        targetTool: "claude",
        targetCwdFallback: undefined,
      },
    ]);
    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0].args, [
      "/tmp/cli.js",
      "--backend",
      "claude",
      "--resume",
      "sess-bridged-1",
      "--",
    ]);
    assert.strictEqual(spawnCalls[0].opts.cwd, "/tmp/bridged-cwd");
    assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_TASK_ID, "task-successor-1");
    assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_RESUME_CWD, "/tmp/bridged-cwd");

    daemonInstance.close();
  });

  it("bridges same-backend successor tasks and launches the new task", async () => {
    let handler;
    const spawnCalls = [];
    const bridgeCalls = [];

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-restart-fork-same-backend",
        CLI_PATH: "/tmp/cli.js",
        NAME: "restart-fork-same-backend-daemon",
      },
      {
        spawn: (_cmd, args, opts) => {
          spawnCalls.push({ args, opts });
          return {
            pid: 61234,
            kill: () => {},
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        bridgeSessionBetweenBackends: async (params) => {
          bridgeCalls.push(params);
          return {
            sessionId: "sess-codex-fork-1",
            cwd: "/tmp/codex-fork-cwd",
          };
        },
        resolveResumeContext: async () => ({ cwd: "" }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (nextHandler) => {
            handler = nextHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    handler({
      type: "restart_task",
      payload: {
        mode: "fork_to_new_task",
        source_task_id: "task-source-same-1",
        target_task_id: "task-successor-same-1",
        project_id: "proj-fork-same-1",
        title: "Fix login bug [codex]",
        source_backend_type: "codex",
        source_session_id: "sess-codex-source-1",
        source_session_file_path: "/tmp/sess-codex-source-1.jsonl",
        target_backend_type: "codex",
        request_id: "req-fork-same-1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepStrictEqual(bridgeCalls, [
      {
        sourceTool: "codex",
        sourceSessionId: "sess-codex-source-1",
        sourceSessionPath: "/tmp/sess-codex-source-1.jsonl",
        sourceSessionInfo: {
          tool: "codex",
          sessionId: "sess-codex-source-1",
          path: "/tmp/sess-codex-source-1.jsonl",
          cwd: undefined,
        },
        targetTool: "codex",
        targetCwdFallback: undefined,
      },
    ]);
    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0].args, [
      "/tmp/cli.js",
      "--backend",
      "codex",
      "--resume",
      "sess-codex-fork-1",
      "--",
    ]);
    assert.strictEqual(spawnCalls[0].opts.cwd, "/tmp/codex-fork-cwd");
    assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_TASK_ID, "task-successor-same-1");
    assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_RESUME_CWD, "/tmp/codex-fork-cwd");

    daemonInstance.close();
  });

  it("loads the local ai-bridge helper from CONDUCTOR_AI_BRIDGE_API_PATH when no injected bridge is provided", async () => {
    let handler;
    const spawnCalls = [];
    const previousBridgeApiPath = process.env.CONDUCTOR_AI_BRIDGE_API_PATH;
    const tempDir = `/tmp/conductor-bridge-api-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const bridgeApiPath = path.join(tempDir, "bridge-api.mjs");

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      bridgeApiPath,
      `export async function bridgeSessionBetweenBackends(params) {
        if (
          params.sourceTool !== "codex" ||
          params.sourceSessionId !== "sess-codex-local-1" ||
          params.targetTool !== "claude" ||
          params.targetCwdFallback !== "/tmp/project-fallback-cwd"
        ) {
          throw new Error("unexpected bridge params: " + JSON.stringify(params));
        }
        return {
          sessionId: "sess-local-fallback",
          cwd: "/tmp/local-bridge-cwd",
          irPath: "/tmp/bridge-ir.jsonl",
          entryCount: 1,
        };
      }\n`,
      "utf8",
    );
    process.env.CONDUCTOR_AI_BRIDGE_API_PATH = bridgeApiPath;

    try {
      const daemonInstance = startDaemon(
        {
          BACKEND_URL: "ws://localhost:0",
          BACKEND_HTTP: "http://localhost:6152",
          WORKSPACE_ROOT: "/tmp/test-ws-restart-local-bridge",
          CLI_PATH: "/tmp/cli.js",
          NAME: "restart-local-bridge-daemon",
        },
        {
          spawn: (_cmd, args, opts) => {
            spawnCalls.push({ args, opts });
            return {
              pid: 63456,
              kill: () => {},
              on: () => {},
              stdout: { on: () => {} },
              stderr: { on: () => {} },
            };
          },
          mkdirSync: () => {},
          writeFileSync: () => {},
          existsSync: () => false,
          readFileSync: () => "",
          unlinkSync: () => {},
          renameSync: () => {},
          createWriteStream: () => ({
            on: () => {},
            write: () => {},
            end: () => {},
          }),
          fetch: async (url) => {
            if (String(url).includes("/api/projects/")) {
              return {
                ok: true,
                json: async () => ({ metadata: { localPaths: { default: "/tmp/project-fallback-cwd" } } }),
              };
            }
            if (String(url).endsWith("/api/tasks")) {
              return { ok: true, json: async () => [] };
            }
            return { ok: true, json: async () => ({}) };
          },
          createWebSocketClient: () => ({
            registerHandler: (nextHandler) => {
              handler = nextHandler;
            },
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async () => {},
          }),
        },
      );

      handler({
        type: "restart_task",
        payload: {
          mode: "bridge_to_new_task",
          source_task_id: "task-source-local-1",
          target_task_id: "task-successor-local-1",
          project_id: "proj-bridge-local-1",
          title: "Fix login bug [claude]",
          source_backend_type: "codex",
          source_session_id: "sess-codex-local-1",
          target_backend_type: "claude",
          request_id: "req-bridge-local-1",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.strictEqual(spawnCalls.length, 1);
      assert.deepStrictEqual(spawnCalls[0].args, [
        "/tmp/cli.js",
        "--backend",
        "claude",
        "--resume",
        "sess-local-fallback",
        "--",
      ]);
      assert.strictEqual(spawnCalls[0].opts.cwd, "/tmp/local-bridge-cwd");
      assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_TASK_ID, "task-successor-local-1");
      assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_RESUME_CWD, "/tmp/local-bridge-cwd");

      daemonInstance.close();
    } finally {
      restoreEnv("CONDUCTOR_AI_BRIDGE_API_PATH", previousBridgeApiPath);
    }
  });

  it("retries loading the local ai-bridge helper after an initial import failure", async () => {
    let handler;
    const sentEvents = [];
    const spawnCalls = [];
    const previousBridgeApiPath = process.env.CONDUCTOR_AI_BRIDGE_API_PATH;
    const tempDir = `/tmp/conductor-bridge-api-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const missingBridgeApiPath = path.join(tempDir, "missing-bridge-api.mjs");
    const workingBridgeApiPath = path.join(tempDir, "working-bridge-api.mjs");

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      workingBridgeApiPath,
      `export async function bridgeSessionBetweenBackends(params) {
        if (
          params.sourceTool !== "codex" ||
          params.sourceSessionId !== "sess-codex-retry-2" ||
          params.targetTool !== "claude" ||
          params.targetCwdFallback !== "/tmp/project-fallback-cwd" ||
          params.sourceSessionInfo?.cwd !== "/tmp/project-fallback-cwd"
        ) {
          throw new Error("unexpected bridge params: " + JSON.stringify(params));
        }
        return {
          sessionId: "sess-local-retry",
          cwd: "/tmp/local-bridge-retry-cwd",
          irPath: "/tmp/bridge-ir-retry.jsonl",
          entryCount: 1,
        };
      }\n`,
      "utf8",
    );

    process.env.CONDUCTOR_AI_BRIDGE_API_PATH = missingBridgeApiPath;

    try {
      const daemonInstance = startDaemon(
        {
          BACKEND_URL: "ws://localhost:0",
          BACKEND_HTTP: "http://localhost:6152",
          WORKSPACE_ROOT: "/tmp/test-ws-restart-local-bridge-retry",
          CLI_PATH: "/tmp/cli.js",
          NAME: "restart-local-bridge-retry-daemon",
        },
        {
          spawn: (_cmd, args, opts) => {
            spawnCalls.push({ args, opts });
            return {
              pid: 63457,
              kill: () => {},
              on: () => {},
              stdout: { on: () => {} },
              stderr: { on: () => {} },
            };
          },
          mkdirSync: () => {},
          writeFileSync: () => {},
          existsSync: () => false,
          readFileSync: () => "",
          unlinkSync: () => {},
          renameSync: () => {},
          createWriteStream: () => ({
            on: () => {},
            write: () => {},
            end: () => {},
          }),
          fetch: async (url) => {
            if (String(url).includes("/api/projects/")) {
              return {
                ok: true,
                json: async () => ({ metadata: { localPaths: { default: "/tmp/project-fallback-cwd" } } }),
              };
            }
            if (String(url).endsWith("/api/tasks")) {
              return { ok: true, json: async () => [] };
            }
            return { ok: true, json: async () => ({}) };
          },
          createWebSocketClient: () => ({
            registerHandler: (nextHandler) => {
              handler = nextHandler;
            },
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async (payload) => {
              sentEvents.push(payload);
            },
          }),
        },
      );

      handler({
        type: "restart_task",
        payload: {
          mode: "bridge_to_new_task",
          source_task_id: "task-source-retry-1",
          target_task_id: "task-successor-retry-1",
          project_id: "proj-bridge-retry-1",
          title: "Fix login bug [claude]",
          source_backend_type: "codex",
          source_session_id: "sess-codex-retry-1",
          target_backend_type: "claude",
          request_id: "req-bridge-retry-1",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expectEvent(sentEvents, "task_status_update", (payload) => {
        assert.strictEqual(payload.task_id, "task-successor-retry-1");
        assert.strictEqual(payload.status, "KILLED");
        assert.match(payload.summary, /new task failed/i);
      });
      assert.strictEqual(spawnCalls.length, 0);

      process.env.CONDUCTOR_AI_BRIDGE_API_PATH = workingBridgeApiPath;

      handler({
        type: "restart_task",
        payload: {
          mode: "bridge_to_new_task",
          source_task_id: "task-source-retry-2",
          target_task_id: "task-successor-retry-2",
          project_id: "proj-bridge-retry-2",
          title: "Fix login bug [claude]",
          source_backend_type: "codex",
          source_session_id: "sess-codex-retry-2",
          target_backend_type: "claude",
          request_id: "req-bridge-retry-2",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.strictEqual(spawnCalls.length, 1);
      assert.deepStrictEqual(spawnCalls[0].args, [
        "/tmp/cli.js",
        "--backend",
        "claude",
        "--resume",
        "sess-local-retry",
        "--",
      ]);
      assert.strictEqual(spawnCalls[0].opts.cwd, "/tmp/local-bridge-retry-cwd");
      assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_TASK_ID, "task-successor-retry-2");
      assert.strictEqual(spawnCalls[0].opts.env.CONDUCTOR_RESUME_CWD, "/tmp/local-bridge-retry-cwd");

      daemonInstance.close();
    } finally {
      restoreEnv("CONDUCTOR_AI_BRIDGE_API_PATH", previousBridgeApiPath);
    }
  });

  it("reports killed summary when backend bridge fails", async () => {
    let handler;
    const sentEvents = [];
    let spawnCount = 0;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-restart-bridge-fail",
        CLI_PATH: "/tmp/cli.js",
        NAME: "restart-bridge-fail-daemon",
      },
      {
        spawn: () => {
          spawnCount += 1;
          throw new Error("spawn should not be called");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        bridgeSessionBetweenBackends: async () => {
          throw new Error("bridge exploded");
        },
        resolveResumeContext: async () => ({ cwd: "" }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (nextHandler) => {
            handler = nextHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    handler({
      type: "restart_task",
      payload: {
        mode: "bridge_to_new_task",
        source_task_id: "task-source-fail-1",
        target_task_id: "task-successor-fail-1",
        project_id: "proj-bridge-fail-1",
        title: "Fix login bug [claude]",
        source_backend_type: "codex",
        source_session_id: "sess-codex-fail-1",
        target_backend_type: "claude",
        request_id: "req-bridge-fail-1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(spawnCount, 0);
    expectEvent(sentEvents, "agent_command_ack", (payload) => {
      assert.strictEqual(payload.request_id, "req-bridge-fail-1");
      assert.strictEqual(payload.event_type, "restart_task");
      assert.strictEqual(payload.accepted, true);
    });
    expectEvent(sentEvents, "task_status_update", (payload) => {
      assert.strictEqual(payload.task_id, "task-successor-fail-1");
      assert.strictEqual(payload.status, "KILLED");
      assert.match(payload.summary, /new task failed: bridge exploded/);
    });

    daemonInstance.close();
  });

  it("creates PTY tasks and sends a terminal snapshot on fresh attach", async () => {
    let handler;
    let onData = null;
    const writes = [];
    const resizes = [];
    const sentEvents = [];
    let webSocketClientOptions = null;

    const mockPty = {
      pid: 88888,
      write: (data) => {
        writes.push(data);
      },
      resize: (cols, rows) => {
        resizes.push([cols, rows]);
      },
      kill: () => {},
      onData: (fn) => {
        onData = fn;
      },
      onExit: () => {},
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-task",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-task-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async (command, args, options) => {
          assert.strictEqual(
            command,
            resolveDefaultPtyShell({
              envShell: process.env.SHELL,
              comspec: process.env.COMSPEC,
              platform: process.platform,
              existsSync: () => false,
            }),
          );
          assert.deepStrictEqual(args, ["-l"]);
          assert.strictEqual(options.cwd, "/tmp/test-ws-pty-bound");
          assert.strictEqual(options.cols, 120);
          assert.strictEqual(options.rows, 40);
          return mockPty;
        },
        createWebSocketClient: (_sdkConfig, options) => {
          webSocketClientOptions = options;
          return {
            registerHandler: (h) => {
              handler = h;
            },
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async (payload) => {
              sentEvents.push(payload);
            },
          };
        },
      },
    );

    assert.ok(typeof handler === "function");
    assert.strictEqual(webSocketClientOptions.extraHeaders["x-conductor-capabilities"], "pty_task,terminal_snapshot");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-1",
        project_id: "proj-pty-1",
        pty_session_id: "pty-session-1",
        request_id: "req-pty-1",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-bound",
          cols: 120,
          rows: 40,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    handler({
      type: "terminal_input",
      payload: {
        task_id: "task-pty-1",
        data: "ls\r",
        client_input_seq: 1,
        client_sent_at: "2026-03-17T01:00:00.000Z",
        server_received_at: "2026-03-17T01:00:00.010Z",
      },
    });
    handler({
      type: "terminal_resize",
      payload: {
        task_id: "task-pty-1",
        cols: 100,
        rows: 32,
      },
    });
    assert.deepStrictEqual(writes, ["ls\r"]);
    assert.deepStrictEqual(resizes, [[100, 32]]);

    assert.ok(typeof onData === "function");
    onData("hello from pty");
    await new Promise((resolve) => setTimeout(resolve, 20));

    handler({
      type: "terminal_attach",
      payload: {
        task_id: "task-pty-1",
        last_seq: 0,
        connection_id: "conn-app-1",
        resume_strategy: "snapshot",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expectEvent(sentEvents, "agent_command_ack", (payload) => {
      assert.strictEqual(payload.task_id, "task-pty-1");
      assert.strictEqual(payload.event_type, "create_pty_task");
      assert.strictEqual(payload.accepted, true);
    });
    expectEvent(sentEvents, "terminal_opened", (payload) => {
      assert.strictEqual(payload.task_id, "task-pty-1");
      assert.strictEqual(payload.pty_session_id, "pty-session-1");
      assert.strictEqual(payload.cwd, "/tmp/test-ws-pty-bound");
    });
    const openedEvents = sentEvents.filter((event) => event.type === "terminal_opened");
    assert.ok(openedEvents.length >= 2);
    assert.strictEqual(openedEvents[0].payload.started_at, openedEvents[1].payload.started_at);
    const outputEvents = sentEvents.filter((event) => event.type === "terminal_output");
    assert.strictEqual(outputEvents.length, 1);
    assert.deepStrictEqual(
      outputEvents.map((event) => event.payload.data),
      ["hello from pty"],
    );
    assert.deepStrictEqual(
      outputEvents.map((event) => event.payload.seq),
      [1],
    );
    assert.deepStrictEqual(outputEvents[0].payload.latency_sample.client_input_seq, 1);
    assert.strictEqual(outputEvents[0].payload.latency_sample.client_sent_at, "2026-03-17T01:00:00.000Z");
    assert.strictEqual(outputEvents[0].payload.latency_sample.server_received_at, "2026-03-17T01:00:00.010Z");
    assert.ok(typeof outputEvents[0].payload.latency_sample.daemon_received_at === "string");
    assert.ok(typeof outputEvents[0].payload.latency_sample.first_output_at === "string");
    assert.ok(typeof outputEvents[0].payload.latency_sample.daemon_input_to_first_output_ms === "number");
    const snapshotEvents = sentEvents.filter((event) => event.type === "terminal_snapshot");
    assert.deepStrictEqual(snapshotEvents.map((event) => event.payload), [
      {
        task_id: "task-pty-1",
        project_id: "proj-pty-1",
        pty_session_id: "pty-session-1",
        connection_id: "conn-app-1",
        last_seq: 1,
        data: "hello from pty",
        truncated: false,
      },
    ]);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("bounds PTY replay buffer by total bytes and drops the oldest chunks first", async () => {
    let handler;
    let onData = null;
    const sentEvents = [];

    const mockPty = {
      pid: 77777,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: (fn) => {
        onData = fn;
      },
      onExit: () => {},
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-byte-bound",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-byte-daemon",
        TERMINAL_RING_BUFFER_MAX_BYTES: "10",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-byte-1",
        project_id: "proj-pty-byte-1",
        pty_session_id: "pty-byte-session-1",
        request_id: "req-pty-byte-1",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-byte-bound",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(typeof onData === "function");
    onData("12345");
    onData("6789");
    onData("ABCD");
    await new Promise((resolve) => setTimeout(resolve, 20));

    sentEvents.length = 0;
    handler({
      type: "terminal_attach",
      payload: {
        task_id: "task-pty-byte-1",
        last_seq: 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const outputEvents = sentEvents.filter((event) => event.type === "terminal_output");
    assert.deepStrictEqual(
      outputEvents.map((event) => event.payload.data),
      ["6789", "ABCD"],
    );
    assert.deepStrictEqual(
      outputEvents.map((event) => event.payload.seq),
      [2, 3],
    );

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("disables PTY capability headers and rejects PTY tasks when startup self-check fails", async () => {
    let handler;
    let webSocketClientOptions;
    const sentEvents = [];

    startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-disabled",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-disabled-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        createPty: () => {
          throw new Error("createPty should not be called when PTY capability is disabled");
        },
        resolvePtyTaskCapability: () => ({
          enabled: false,
          reason: "Failed to load native module: pty.node",
          spawnHelperInfo: null,
          spawnPty: null,
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_sdkConfig, options) => {
          webSocketClientOptions = options;
          return {
            registerHandler: (nextHandler) => {
              handler = nextHandler;
            },
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async (payload) => {
              sentEvents.push(payload);
            },
          };
        },
      },
    );

    assert.ok(typeof handler === "function");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(webSocketClientOptions.extraHeaders, "x-conductor-capabilities"),
      false,
    );

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-disabled-1",
        project_id: "proj-pty-disabled-1",
        pty_session_id: "pty-session-disabled-1",
        request_id: "req-pty-disabled-1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expectEvent(sentEvents, "agent_command_ack", (payload) => {
      assert.strictEqual(payload.task_id, "task-pty-disabled-1");
      assert.strictEqual(payload.event_type, "create_pty_task");
      assert.strictEqual(payload.accepted, false);
    });
    expectEvent(sentEvents, "terminal_error", (payload) => {
      assert.strictEqual(payload.task_id, "task-pty-disabled-1");
      assert.strictEqual(
        payload.message,
        "pty runtime unavailable: Failed to load native module: pty.node",
      );
    });
  });

  it("returns an answer placeholder and falls back to relay when receiving a PTY offer", async () => {
    let handler;
    const sentEvents = [];
    const originalDisableRtc = process.env.CONDUCTOR_DISABLE_PTY_DIRECT_RTC;

    const mockPty = {
      pid: 55555,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    };

    restoreEnv("CONDUCTOR_DISABLE_PTY_DIRECT_RTC", "1");

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-direct-fallback",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-direct-fallback-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    try {
      assert.ok(typeof handler === "function");

      handler({
        type: "create_pty_task",
        payload: {
          task_id: "task-pty-direct-1",
          project_id: "proj-pty-direct-1",
          pty_session_id: "pty-direct-session-1",
          request_id: "req-pty-direct-1",
          launch_config: {
            entrypoint_type: "shell",
            cwd: "/tmp/test-ws-pty-direct-fallback",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      handler({
        type: "pty_transport_signal",
        payload: {
          task_id: "task-pty-direct-1",
          session_id: "transport-1",
          connection_id: "conn-app-1",
          signal_type: "offer",
          description: {
            type: "offer",
            sdp: "v=0",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      expectEvent(sentEvents, "pty_transport_signal", (payload) => {
        assert.strictEqual(payload.task_id, "task-pty-direct-1");
        assert.strictEqual(payload.session_id, "transport-1");
        assert.strictEqual(payload.connection_id, "conn-app-1");
        assert.strictEqual(payload.signal_type, "answer_placeholder");
        assert.strictEqual(payload.description.type, "answer");
        assert.strictEqual(payload.description.mode, "placeholder");
        assert.strictEqual(payload.description.reason, "direct_transport_not_supported");
      });
      expectEvent(sentEvents, "pty_transport_status", (payload) => {
        assert.strictEqual(payload.task_id, "task-pty-direct-1");
        assert.strictEqual(payload.session_id, "transport-1");
        assert.strictEqual(payload.connection_id, "conn-app-1");
        assert.strictEqual(payload.transport_state, "fallback_relay");
        assert.strictEqual(payload.reason, "direct_transport_not_supported");
      });
    } finally {
      restoreEnv("CONDUCTOR_DISABLE_PTY_DIRECT_RTC", originalDisableRtc);
      if (daemonInstance && typeof daemonInstance.close === "function") {
        daemonInstance.close();
      }
    }
  });

  it("returns a real PTY answer when an RTC peer implementation is available", async () => {
    let handler;
    const sentEvents = [];

    const mockPty = {
      pid: 55556,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    };

    class MockRtcPeerConnection {
      async setRemoteDescription(description) {
        this.remoteDescription = description;
      }

      async createAnswer() {
        return {
          type: "answer",
          sdp: "v=0-answer",
        };
      }

      async setLocalDescription(description) {
        this.localDescription = description;
      }

      async addIceCandidate() {}

      close() {}
    }

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-direct-answer",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-direct-answer-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createRtcPeerConnection: () => new MockRtcPeerConnection(),
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-direct-2",
        project_id: "proj-pty-direct-2",
        pty_session_id: "pty-direct-session-2",
        request_id: "req-pty-direct-2",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-direct-answer",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    handler({
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-direct-2",
        session_id: "transport-2",
        connection_id: "conn-app-2",
        signal_type: "offer",
        description: {
          type: "offer",
          sdp: "v=0-offer",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expectEvent(sentEvents, "pty_transport_signal", (payload) => {
      assert.strictEqual(payload.task_id, "task-pty-direct-2");
      assert.strictEqual(payload.session_id, "transport-2");
      assert.strictEqual(payload.connection_id, "conn-app-2");
      assert.strictEqual(payload.signal_type, "answer");
      assert.deepStrictEqual(payload.description, {
        type: "answer",
        sdp: "v=0-answer",
      });
    });

    expectEvent(sentEvents, "pty_transport_status", (payload) => {
      assert.strictEqual(payload.task_id, "task-pty-direct-2");
      assert.strictEqual(payload.session_id, "transport-2");
      assert.strictEqual(payload.connection_id, "conn-app-2");
      assert.strictEqual(payload.transport_state, "negotiating");
      assert.strictEqual(payload.transport_policy, "direct_preferred");
      assert.strictEqual(payload.direct_candidate, true);
    });

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("loads PTY RTC runtime from optional module candidates when available", async () => {
    let handler;
    const sentEvents = [];
    const importedModules = [];
    const originalRtcModules = process.env.CONDUCTOR_PTY_RTC_MODULES;

    const mockPty = {
      pid: 55558,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    };

    class MockRtcPeerConnection {
      async setRemoteDescription(description) {
        this.remoteDescription = description;
      }

      async createAnswer() {
        return {
          type: "answer",
          sdp: "v=0-answer-from-module",
        };
      }

      async setLocalDescription(description) {
        this.localDescription = description;
      }

      async addIceCandidate() {}

      close() {}
    }

    restoreEnv("CONDUCTOR_PTY_RTC_MODULES", "@roamhq/wrtc,wrtc");

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-direct-answer-module",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-direct-answer-module-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        importOptionalModule: async (moduleName) => {
          importedModules.push(moduleName);
          if (moduleName === "@roamhq/wrtc") {
            return { RTCPeerConnection: MockRtcPeerConnection };
          }
          throw new Error(`unexpected module ${moduleName}`);
        },
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    try {
      assert.ok(typeof handler === "function");

      handler({
        type: "create_pty_task",
        payload: {
          task_id: "task-pty-direct-3",
          project_id: "proj-pty-direct-3",
          pty_session_id: "pty-direct-session-3",
          request_id: "req-pty-direct-3",
          launch_config: {
            entrypoint_type: "shell",
            cwd: "/tmp/test-ws-pty-direct-answer-module",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      handler({
        type: "pty_transport_signal",
        payload: {
          task_id: "task-pty-direct-3",
          session_id: "transport-3",
          connection_id: "conn-app-3",
          signal_type: "offer",
          description: {
            type: "offer",
            sdp: "v=0-offer-3",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.deepStrictEqual(importedModules, ["@roamhq/wrtc"]);
      expectEvent(sentEvents, "pty_transport_signal", (payload) => {
        assert.strictEqual(payload.task_id, "task-pty-direct-3");
        assert.strictEqual(payload.session_id, "transport-3");
        assert.strictEqual(payload.connection_id, "conn-app-3");
        assert.strictEqual(payload.signal_type, "answer");
        assert.deepStrictEqual(payload.description, {
          type: "answer",
          sdp: "v=0-answer-from-module",
        });
      });
    } finally {
      restoreEnv("CONDUCTOR_PTY_RTC_MODULES", originalRtcModules);
      if (daemonInstance && typeof daemonInstance.close === "function") {
        daemonInstance.close();
      }
    }
  });

  it("routes PTY input/output over the direct RTC data channel when it is open", async () => {
    let handler;
    let onData = null;
    const writes = [];
    const sentEvents = [];
    let directChannel = null;

    const mockPty = {
      pid: 55557,
      write: (data) => {
        writes.push(data);
      },
      resize: () => {},
      kill: () => {},
      onData: (fn) => {
        onData = fn;
      },
      onExit: () => {},
    };

    class MockRtcPeerConnection {
      constructor() {
        this.ondatachannel = null;
      }

      async setRemoteDescription() {
        directChannel = {
          readyState: "open",
          sent: [],
          onopen: null,
          onclose: null,
          onmessage: null,
          send(payload) {
            this.sent.push(payload);
          },
          close() {},
        };
        this.ondatachannel?.({ channel: directChannel });
      }

      async createAnswer() {
        return {
          type: "answer",
          sdp: "v=0-answer",
        };
      }

      async setLocalDescription() {}

      async addIceCandidate() {}

      close() {}
    }

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-direct-io",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-direct-io-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createRtcPeerConnection: () => new MockRtcPeerConnection(),
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-direct-io-1",
        project_id: "proj-pty-direct-io-1",
        pty_session_id: "pty-direct-io-session-1",
        request_id: "req-pty-direct-io-1",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-direct-io",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    handler({
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-direct-io-1",
        session_id: "transport-io-1",
        connection_id: "conn-app-io-1",
        signal_type: "offer",
        description: {
          type: "offer",
          sdp: "v=0-offer",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    directChannel.onopen?.();
    directChannel.onmessage?.({
      data: JSON.stringify({
        type: "terminal_input",
        payload: {
          task_id: "task-pty-direct-io-1",
          data: "pwd\r",
          client_input_seq: 1,
          client_sent_at: "2026-03-17T10:00:00.000Z",
        },
      }),
    });

    assert.deepStrictEqual(writes, ["pwd\r"]);

    assert.ok(typeof onData === "function");
    onData("direct output");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
      directChannel.sent.some((payload) => {
        const parsed = JSON.parse(payload);
        return parsed.type === "terminal_output" && parsed.payload.data === "direct output";
      }),
    );
    assert.ok(
      sentEvents.some((event) => event.type === "terminal_output" && event.payload.data === "direct output"),
    );

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("ignores stale direct-channel input after the writer transport is revoked", async () => {
    let handler;
    let directChannel = null;
    const writes = [];

    const mockPty = {
      pid: 55559,
      write: (data) => {
        writes.push(data);
      },
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    };

    class MockRtcPeerConnection {
      constructor() {
        this.ondatachannel = null;
      }

      async setRemoteDescription() {
        directChannel = {
          readyState: "open",
          onopen: null,
          onclose: null,
          onmessage: null,
          send() {},
          close() {},
        };
        this.ondatachannel?.({ channel: directChannel });
      }

      async createAnswer() {
        return {
          type: "answer",
          sdp: "v=0-answer",
        };
      }

      async setLocalDescription() {}

      async addIceCandidate() {}

      close() {}
    }

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-direct-revoke",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-direct-revoke-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createRtcPeerConnection: () => new MockRtcPeerConnection(),
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-direct-revoke-1",
        project_id: "proj-pty-direct-revoke-1",
        pty_session_id: "pty-direct-revoke-session-1",
        request_id: "req-pty-direct-revoke-1",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-direct-revoke",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    handler({
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-direct-revoke-1",
        session_id: "transport-revoke-1",
        connection_id: "conn-app-revoke-1",
        signal_type: "offer",
        description: {
          type: "offer",
          sdp: "v=0-offer",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    directChannel.onopen?.();

    handler({
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-direct-revoke-1",
        connection_id: "conn-app-revoke-1",
        signal_type: "revoke",
      },
    });

    directChannel.onmessage?.({
      data: JSON.stringify({
        type: "terminal_input",
        payload: {
          task_id: "task-pty-direct-revoke-1",
          data: "whoami\r",
        },
      }),
    });

    assert.deepStrictEqual(writes, []);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("switches direct output to the new writer transport after takeover", async () => {
    let handler;
    let onData = null;
    const writes = [];
    const sentEvents = [];
    const directChannels = [];

    const mockPty = {
      pid: 55560,
      write: (data) => {
        writes.push(data);
      },
      resize: () => {},
      kill: () => {},
      onData: (fn) => {
        onData = fn;
      },
      onExit: () => {},
    };

    class MockRtcPeerConnection {
      constructor() {
        this.ondatachannel = null;
      }

      async setRemoteDescription() {
        const channel = {
          readyState: "open",
          sent: [],
          onopen: null,
          onclose: null,
          onmessage: null,
          send(payload) {
            this.sent.push(payload);
          },
          close() {},
        };
        directChannels.push(channel);
        this.ondatachannel?.({ channel });
      }

      async createAnswer() {
        return {
          type: "answer",
          sdp: "v=0-answer",
        };
      }

      async setLocalDescription() {}

      async addIceCandidate() {}

      close() {}
    }

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-direct-takeover",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-direct-takeover-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createRtcPeerConnection: () => new MockRtcPeerConnection(),
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-direct-takeover-1",
        project_id: "proj-pty-direct-takeover-1",
        pty_session_id: "pty-direct-takeover-session-1",
        request_id: "req-pty-direct-takeover-1",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-direct-takeover",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    handler({
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-direct-takeover-1",
        session_id: "transport-takeover-1",
        connection_id: "conn-app-old-writer",
        signal_type: "offer",
        description: {
          type: "offer",
          sdp: "v=0-offer-old",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstChannel = directChannels[0];
    firstChannel.onopen?.();

    assert.ok(typeof onData === "function");
    onData("before takeover");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstChannelOutputCount = firstChannel.sent.length;

    handler({
      type: "pty_transport_signal",
      payload: {
        task_id: "task-pty-direct-takeover-1",
        session_id: "transport-takeover-2",
        connection_id: "conn-app-new-writer",
        signal_type: "offer",
        description: {
          type: "offer",
          sdp: "v=0-offer-new",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondChannel = directChannels[1];
    secondChannel.onopen?.();

    firstChannel.onmessage?.({
      data: JSON.stringify({
        type: "terminal_input",
        payload: {
          task_id: "task-pty-direct-takeover-1",
          data: "stale\r",
        },
      }),
    });
    secondChannel.onmessage?.({
      data: JSON.stringify({
        type: "terminal_input",
        payload: {
          task_id: "task-pty-direct-takeover-1",
          data: "fresh\r",
        },
      }),
    });

    assert.deepStrictEqual(writes, ["fresh\r"]);

    onData("after takeover");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(firstChannel.sent.length, firstChannelOutputCount);
    assert.ok(
      secondChannel.sent.some((payload) => {
        const parsed = JSON.parse(payload);
        return parsed.type === "terminal_output" && parsed.payload.data === "after takeover";
      }),
    );
    assert.ok(
      sentEvents.some((event) => event.type === "terminal_output" && event.payload.data === "after takeover"),
    );

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("keeps only the tail of a single oversized PTY chunk within the byte budget", async () => {
    let handler;
    let onData = null;
    const sentEvents = [];

    const mockPty = {
      pid: 66666,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: (fn) => {
        onData = fn;
      },
      onExit: () => {},
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-byte-tail",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-byte-tail-daemon",
        TERMINAL_RING_BUFFER_MAX_BYTES: "4",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-byte-2",
        project_id: "proj-pty-byte-2",
        pty_session_id: "pty-byte-session-2",
        request_id: "req-pty-byte-2",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-byte-tail",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(typeof onData === "function");
    onData("123456");
    await new Promise((resolve) => setTimeout(resolve, 20));

    sentEvents.length = 0;
    handler({
      type: "terminal_attach",
      payload: {
        task_id: "task-pty-byte-2",
        last_seq: 0,
        connection_id: "conn-app-2",
        resume_strategy: "snapshot",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshotEvents = sentEvents.filter((event) => event.type === "terminal_snapshot");
    assert.deepStrictEqual(snapshotEvents.map((event) => event.payload), [
      {
        task_id: "task-pty-byte-2",
        project_id: "proj-pty-byte-2",
        pty_session_id: "pty-byte-session-2",
        connection_id: "conn-app-2",
        last_seq: 1,
        data: "3456",
        truncated: false,
      },
    ]);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("falls back to legacy terminal_output replay when fresh snapshot resume is not negotiated", async () => {
    let handler;
    let onData = null;
    const sentEvents = [];

    const mockPty = {
      pid: 77778,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: (fn) => {
        onData = fn;
      },
      onExit: () => {},
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-pty-legacy-replay",
        CLI_PATH: "/tmp/cli.js",
        NAME: "pty-task-daemon-legacy-replay",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-legacy-replay",
        project_id: "proj-pty-legacy-replay",
        pty_session_id: "pty-legacy-replay",
        request_id: "req-pty-legacy-replay",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-pty-legacy-replay",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(typeof onData === "function");
    onData("history-1");
    onData("history-2");
    await new Promise((resolve) => setTimeout(resolve, 20));

    sentEvents.length = 0;
    handler({
      type: "terminal_attach",
      payload: {
        task_id: "task-pty-legacy-replay",
        last_seq: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshotEvents = sentEvents.filter((event) => event.type === "terminal_snapshot");
    assert.strictEqual(snapshotEvents.length, 0);
    const outputEvents = sentEvents.filter((event) => event.type === "terminal_output");
    assert.deepStrictEqual(
      outputEvents.map((event) => event.payload.data),
      ["history-1", "history-2"],
    );

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("keeps PTY workspaces stable when no project path is bound", async () => {
    let handler;
    let createdCwd = null;
    let renameCalls = 0;
    const events = [];

    const mockPty = {
      pid: 54321,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-unbound-pty",
        CLI_PATH: "/tmp/cli.js",
        NAME: "unbound-pty-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {
          renameCalls += 1;
        },
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async (_command, _args, options) => {
          createdCwd = options.cwd;
          return mockPty;
        },
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            events.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "12345678-1234-4abc-8def-1234567890ab",
        project_id: "proj-unbound-pty-1",
        pty_session_id: "pty-unbound-1",
        request_id: "req-unbound-pty-1",
        launch_config: {
          entrypoint_type: "shell",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(createdCwd);
    assert.match(
      createdCwd,
      /^\/tmp\/test-ws-unbound-pty\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_pty_12345678$/,
    );
    assert.strictEqual(renameCalls, 0);
    expectEvent(events, "terminal_opened", (payload) => {
      assert.strictEqual(payload.cwd, createdCwd);
      assert.strictEqual(payload.pid, 54321);
    });

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("stops PTY tasks on stop_task and daemon close", async () => {
    let handler;
    const killCalls = [];

    const mockPty = {
      pid: 99999,
      write: () => {},
      resize: () => {},
      kill: (signal) => {
        killCalls.push(signal);
      },
      onData: () => {},
      onExit: () => {},
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-stop-pty",
        CLI_PATH: "/tmp/cli.js",
        NAME: "stop-pty-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-stop-1",
        project_id: "proj-pty-stop-1",
        pty_session_id: "pty-session-stop-1",
        request_id: "req-pty-stop-1",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-stop-pty-bound",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    handler({
      type: "stop_task",
      payload: {
        task_id: "task-pty-stop-1",
        request_id: "req-stop-pty-1",
      },
    });
    assert.deepStrictEqual(killCalls, ["SIGTERM"]);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepStrictEqual(killCalls, ["SIGTERM", "SIGTERM"]);
  });

  it("reports numeric PTY exit signals in terminal_exit events", async () => {
    let handler;
    let exitHandler;
    const events = [];

    const mockPty = {
      pid: 43210,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: (cb) => {
        exitHandler = cb;
      },
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-exit-signal-pty",
        CLI_PATH: "/tmp/cli.js",
        NAME: "exit-signal-pty-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createPty: async () => mockPty,
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            events.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-pty-exit-signal-1",
        project_id: "proj-pty-exit-signal-1",
        pty_session_id: "pty-session-exit-signal-1",
        request_id: "req-pty-exit-signal-1",
        launch_config: {
          entrypoint_type: "shell",
          cwd: "/tmp/test-ws-exit-signal-pty-bound",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(typeof exitHandler === "function");
    exitHandler({ exitCode: 0, signal: 9 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const exitEvent = events.find(
      (event) =>
        event?.type === "terminal_exit" &&
        event?.payload?.task_id === "task-pty-exit-signal-1",
    );
    assert.ok(exitEvent);
    assert.strictEqual(exitEvent.payload.exit_code, 0);
    assert.strictEqual(exitEvent.payload.signal, 9);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("returns collected logs when collect_logs is received", async () => {
    let handler;
    const events = [];

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-collect-logs",
        CLI_PATH: "/tmp/cli.js",
        DAEMON_NAME: "collect-logs-daemon",
      },
      {
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createLogCollector: (backendUrl) => {
          assert.strictEqual(backendUrl, "http://localhost:6152");
          return {
            collect: (taskId, options) => {
              assert.strictEqual(taskId, "task-log-1");
              assert.deepStrictEqual(options, {
                tailLines: 50,
                since: "2026-03-05T12:00:00.000Z",
              });
              return {
                projectPath: "/tmp/project-log-1",
                logPath: "/tmp/project-log-1/conductor.log",
                entries: [
                  {
                    timestamp: "2026-03-05T12:00:30.000Z",
                    level: "INFO",
                    message: "runner started",
                  },
                ],
                truncated: false,
                error: null,
                collectedAt: "2026-03-05T12:01:00.000Z",
              };
            },
          };
        },
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            events.push(payload);
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "collect_logs",
      payload: {
        request_id: "req-log-1",
        task_id: "task-log-1",
        options: {
          tail_lines: 50,
          since: "2026-03-05T12:00:00.000Z",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepStrictEqual(events, [
      {
        type: "agent_log_collected",
        payload: {
          request_id: "req-log-1",
          task_id: "task-log-1",
          daemon_host: "collect-logs-daemon",
          project_path: "/tmp/project-log-1",
          log_path: "/tmp/project-log-1/conductor.log",
          logs: [
            {
              timestamp: "2026-03-05T12:00:30.000Z",
              level: "INFO",
              message: "runner started",
            },
          ],
          truncated: false,
          error: null,
          collected_at: "2026-03-05T12:01:00.000Z",
        },
      },
    ]);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("reports active tasks as killed before disconnect on daemon close", async () => {
    let handler;
    const killCalls = [];
    const events = [];

    const child = {
      pid: 88888,
      kill: (signal) => {
        killCalls.push(signal);
      },
      on: () => {},
      stdout: { on: () => {} },
      stderr: { on: () => {} },
    };

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-ws-close-status",
        CLI_PATH: "/tmp/cli.js",
        NAME: "close-status-daemon",
      },
      {
        spawn: () => child,
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_config, _options) => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {
            events.push({ type: "disconnect" });
          },
          sendJson: async (payload) => {
            events.push({ type: "sendJson", payload });
          },
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_task",
      payload: {
        task_id: "task-close-1",
        project_id: "proj-close-1",
        backend_type: "codex",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepStrictEqual(killCalls, ["SIGTERM"]);

    const runningIdx = events.findIndex(
      (event) =>
        event.type === "sendJson" &&
        event.payload?.type === "task_status_update" &&
        event.payload?.payload?.task_id === "task-close-1" &&
        event.payload?.payload?.status === "RUNNING",
    );
    const killedIdx = events.findIndex(
      (event) =>
        event.type === "sendJson" &&
        event.payload?.type === "task_status_update" &&
        event.payload?.payload?.task_id === "task-close-1" &&
        event.payload?.payload?.status === "KILLED",
    );
    const disconnectIdx = events.findIndex((event) => event.type === "disconnect");

    assert.ok(runningIdx >= 0);
    assert.ok(killedIdx >= 0);
    assert.ok(disconnectIdx >= 0);
    assert.ok(killedIdx < disconnectIdx);
  });

  it("logs backend connection only for initial connect and true reconnect", (t) => {
    const stdoutChunks = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      stdoutChunks.push(String(chunk));
      if (typeof args.at(-1) === "function") {
        args.at(-1)();
      }
      return true;
    };
    t.after(() => {
      process.stdout.write = originalStdoutWrite;
    });

    let callbacks;
    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-ws-log-gate",
        CLI_PATH: "/tmp/cli.js",
        NAME: "log-gate",
      },
      {
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
        createWebSocketClient: (_config, options) => {
          callbacks = options;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            sendJson: async () => {},
          };
        },
      },
    );

    assert.ok(callbacks);
    assert.ok(typeof callbacks.onConnected === "function");
    assert.ok(typeof callbacks.onDisconnected === "function");

    callbacks.onConnected({ isReconnect: false });
    callbacks.onConnected({ isReconnect: true });
    callbacks.onDisconnected();
    callbacks.onConnected({ isReconnect: true });

    const connectedLogs = stdoutChunks.filter((line) => line.includes("Connected to backend"));
    assert.strictEqual(connectedLogs.length, 2);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("logs free-plan daemon limit hint when backend emits error event", (t) => {
    const stderrChunks = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(String(chunk));
      if (typeof args.at(-1) === "function") {
        args.at(-1)();
      }
      return true;
    };
    t.after(() => {
      process.stderr.write = originalStderrWrite;
    });

    let handler;
    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        WORKSPACE_ROOT: "/tmp/test-ws-error-hint",
        CLI_PATH: "/tmp/cli.js",
        NAME: "error-hint",
      },
      {
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async () => ({ ok: true, json: async () => ({ removed: 0, remaining: 0 }) }),
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => {},
        }),
      },
    );

    assert.ok(typeof handler === "function");
    handler({
      type: "error",
      payload: {
        message: "Free plan allows only one active daemon connection",
      },
    });

    const hasLimitHint = stderrChunks.some((line) =>
      line.includes("Free plan limit reached: only 1 active daemon connection is allowed."),
    );
    assert.ok(hasLimitHint);

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("watchdog force-reconnects on stale ws health even when presence probe misses the daemon", async (t) => {
    const originalEnv = {
      interval: process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS,
      stale: process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS,
      grace: process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS,
      cooldown: process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS,
      maxHeals: process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS,
      httpTimeout: process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS,
    };
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS = "20";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS = "1";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS = "3";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS = "20";

    t.after(() => {
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", originalEnv.interval);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS", originalEnv.stale);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS", originalEnv.grace);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS", originalEnv.cooldown);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS", originalEnv.maxHeals);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS", originalEnv.httpTimeout);
    });

    let callbacks;
    const forceReconnectReasons = [];
    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-watchdog",
        CLI_PATH: "/tmp/cli.js",
        NAME: "watchdog-daemon",
      },
      {
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          if (String(url).endsWith("/api/agents")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_config, options) => {
          callbacks = options;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            forceReconnect: async (reason) => {
              forceReconnectReasons.push(reason);
            },
            sendJson: async () => {},
          };
        },
      },
    );

    assert.ok(callbacks);
    callbacks.onConnected({ isReconnect: false, connectedAt: Date.now() - 100 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(forceReconnectReasons.includes("watchdog:stale_ws_health"));
    assert.ok(!forceReconnectReasons.includes("watchdog:backend_missing_host"));

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("watchdog force-reconnects on stale ws health even when presence probe fails", async (t) => {
    const originalEnv = {
      interval: process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS,
      stale: process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS,
      grace: process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS,
      cooldown: process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS,
      maxHeals: process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS,
      httpTimeout: process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS,
    };
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS = "20";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS = "1";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS = "3";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS = "20";

    t.after(() => {
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", originalEnv.interval);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS", originalEnv.stale);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS", originalEnv.grace);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS", originalEnv.cooldown);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS", originalEnv.maxHeals);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS", originalEnv.httpTimeout);
    });

    let callbacks;
    const forceReconnectReasons = [];
    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-watchdog-probe-fail",
        CLI_PATH: "/tmp/cli.js",
        NAME: "watchdog-daemon",
      },
      {
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          if (String(url).endsWith("/api/agents")) {
            return { ok: false, status: 503, json: async () => ({}) };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_config, options) => {
          callbacks = options;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            forceReconnect: async (reason) => {
              forceReconnectReasons.push(reason);
            },
            sendJson: async () => {},
          };
        },
      },
    );

    assert.ok(callbacks);
    callbacks.onConnected({ isReconnect: false, connectedAt: Date.now() - 100 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(forceReconnectReasons.includes("watchdog:stale_ws_health"));

    if (daemonInstance && typeof daemonInstance.close === "function") {
      daemonInstance.close();
    }
  });

  it("watchdog self-heal budget survives reconnect until a post-reconnect health signal", async (t) => {
    const originalEnv = {
      interval: process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS,
      stale: process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS,
      grace: process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS,
      cooldown: process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS,
      maxHeals: process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS,
      httpTimeout: process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS,
    };
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS = "20";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS = "1";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS = "1";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS = "20";

    let daemonInstance;
    t.after(() => {
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", originalEnv.interval);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS", originalEnv.stale);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS", originalEnv.grace);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS", originalEnv.cooldown);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS", originalEnv.maxHeals);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS", originalEnv.httpTimeout);
      if (daemonInstance && typeof daemonInstance.close === "function") {
        daemonInstance.close();
      }
    });

    let callbacks;
    const forceReconnectReasons = [];
    const exitCodes = [];
    daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-watchdog-budget",
        CLI_PATH: "/tmp/cli.js",
        NAME: "watchdog-daemon",
      },
      {
        exit: (code) => {
          exitCodes.push(code);
        },
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          if (String(url).endsWith("/api/agents")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_config, options) => {
          callbacks = options;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            forceReconnect: async (reason) => {
              forceReconnectReasons.push(reason);
            },
            sendJson: async () => {},
          };
        },
      },
    );

    assert.ok(callbacks);
    callbacks.onConnected({ isReconnect: false, connectedAt: Date.now() - 100 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepStrictEqual(forceReconnectReasons, ["watchdog:stale_ws_health"]);
    assert.deepStrictEqual(exitCodes, []);

    callbacks.onConnected({ isReconnect: true, connectedAt: Date.now() - 100 });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepStrictEqual(forceReconnectReasons, ["watchdog:stale_ws_health"]);
    assert.deepStrictEqual(exitCodes, [1]);
  });

  it("watchdog clears self-heal budget after a post-reconnect pong", async (t) => {
    const originalEnv = {
      interval: process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS,
      stale: process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS,
      grace: process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS,
      cooldown: process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS,
      maxHeals: process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS,
      httpTimeout: process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS,
    };
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS = "20";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS = "1";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS = "10";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS = "1";
    process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS = "20";

    let daemonInstance;
    t.after(() => {
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS", originalEnv.interval);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS", originalEnv.stale);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS", originalEnv.grace);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS", originalEnv.cooldown);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS", originalEnv.maxHeals);
      restoreEnv("CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS", originalEnv.httpTimeout);
      if (daemonInstance && typeof daemonInstance.close === "function") {
        daemonInstance.close();
      }
    });

    let callbacks;
    const forceReconnectReasons = [];
    const exitCodes = [];
    daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-watchdog-budget-reset",
        CLI_PATH: "/tmp/cli.js",
        NAME: "watchdog-daemon",
      },
      {
        exit: (code) => {
          exitCodes.push(code);
        },
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        createWriteStream: () => ({
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          if (String(url).endsWith("/api/agents")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: (_config, options) => {
          callbacks = options;
          return {
            registerHandler: () => {},
            connect: async () => {},
            disconnect: async () => {},
            forceReconnect: async (reason) => {
              forceReconnectReasons.push(reason);
            },
            sendJson: async () => {},
          };
        },
      },
    );

    assert.ok(callbacks);
    callbacks.onConnected({ isReconnect: false, connectedAt: Date.now() - 100 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepStrictEqual(forceReconnectReasons, ["watchdog:stale_ws_health"]);
    assert.deepStrictEqual(exitCodes, []);

    callbacks.onConnected({ isReconnect: true, connectedAt: Date.now() });
    callbacks.onPong({ at: Date.now() });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepStrictEqual(exitCodes, []);
    assert.deepStrictEqual(forceReconnectReasons, [
      "watchdog:stale_ws_health",
      "watchdog:stale_ws_health",
    ]);
  });

  it("forces exit on second SIGINT when shutdown is stuck", async (t) => {
    const originalProcessOn = process.on;
    const originalProcessOff = process.off;
    const signalHandlers = new Map();

    process.on = ((eventName, listener) => {
      const list = signalHandlers.get(eventName) || [];
      list.push(listener);
      signalHandlers.set(eventName, list);
      return process;
    });
    process.off = ((eventName, listener) => {
      const list = signalHandlers.get(eventName) || [];
      signalHandlers.set(
        eventName,
        list.filter((item) => item !== listener),
      );
      return process;
    });

    t.after(() => {
      process.on = originalProcessOn;
      process.off = originalProcessOff;
    });

    const exitCodes = [];
    let handler;

    startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-sigint-force",
        CLI_PATH: "/tmp/cli.js",
        NAME: "sigint-force-daemon",
      },
      {
        exit: (code) => {
          exitCodes.push(code);
        },
        spawn: () => ({
          pid: 45678,
          kill: () => {},
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (h) => {
            handler = h;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async () => new Promise(() => {}),
        }),
      },
    );

    assert.ok(typeof handler === "function");

    handler({
      type: "create_task",
      payload: {
        task_id: "task-sigint-force-1",
        project_id: "proj-sigint-force-1",
        backend_type: "codex",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const sigintHandlers = signalHandlers.get("SIGINT") || [];
    assert.strictEqual(sigintHandlers.length, 1);

    sigintHandlers[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(exitCodes, []);

    sigintHandlers[0]();
    assert.deepStrictEqual(exitCodes, [130]);
  });

  it("rejects create_task events received after shutdown begins", async () => {
    let handler;
    let spawnCount = 0;
    const sentEvents = [];

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-shutdown-reject-task",
        CLI_PATH: "/tmp/cli.js",
        NAME: "shutdown-reject-task-daemon",
      },
      {
        spawn: () => {
          spawnCount += 1;
          return {
            pid: 45678,
            kill: () => {},
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (nextHandler) => {
            handler = nextHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    daemonInstance.close();
    handler({
      type: "create_task",
      payload: {
        task_id: "task-shutdown-reject",
        project_id: "proj-shutdown-reject",
        backend_type: "codex",
        request_id: "req-shutdown-reject",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(spawnCount, 0);
    expectEvent(sentEvents, "agent_command_ack", (payload) => {
      assert.strictEqual(payload.request_id, "req-shutdown-reject");
      assert.strictEqual(payload.accepted, false);
      assert.strictEqual(payload.event_type, "create_task");
    });
    expectEvent(sentEvents, "task_status_update", (payload) => {
      assert.strictEqual(payload.task_id, "task-shutdown-reject");
      assert.strictEqual(payload.status, "KILLED");
      assert.strictEqual(payload.summary, "daemon shutting down");
    });
  });

  it("does not spawn create_task if shutdown starts during project path lookup", async () => {
    let handler;
    let spawnCount = 0;
    const sentEvents = [];
    let resolveProjectLookup;

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-shutdown-late-task",
        CLI_PATH: "/tmp/cli.js",
        NAME: "shutdown-late-task-daemon",
      },
      {
        spawn: () => {
          spawnCount += 1;
          return {
            pid: 56789,
            kill: () => {},
            on: () => {},
            stdout: { on: () => {} },
            stderr: { on: () => {} },
          };
        },
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return new Promise((resolve) => {
              resolveProjectLookup = () => {
                resolve({ ok: true, json: async () => ({ metadata: null }) });
              };
            });
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (nextHandler) => {
            handler = nextHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    handler({
      type: "create_task",
      payload: {
        task_id: "task-shutdown-late",
        project_id: "proj-shutdown-late",
        backend_type: "codex",
        request_id: "req-shutdown-late",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    daemonInstance.close();
    resolveProjectLookup();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(spawnCount, 0);
    const killedEvent = sentEvents.find(
      (entry) =>
        entry.type === "task_status_update" &&
        entry.payload?.task_id === "task-shutdown-late" &&
        entry.payload?.status === "KILLED",
    );
    assert.ok(killedEvent, "expected shutdown KILLED status update");
    assert.strictEqual(killedEvent.payload.summary, "daemon shutting down");
  });

  it("kills pending PTY creation if shutdown starts before the PTY launches", async () => {
    let handler;
    let resolvePty;
    const sentEvents = [];
    const killCalls = [];

    const daemonInstance = startDaemon(
      {
        BACKEND_URL: "ws://localhost:0",
        BACKEND_HTTP: "http://localhost:6152",
        WORKSPACE_ROOT: "/tmp/test-daemon-shutdown-late-pty",
        CLI_PATH: "/tmp/cli.js",
        NAME: "shutdown-late-pty-daemon",
      },
      {
        spawn: () => {
          throw new Error("spawn should not be called for create_pty_task");
        },
        createPty: () =>
          new Promise((resolve) => {
            resolvePty = () => {
              resolve({
                pid: 67890,
                kill: (signal) => {
                  killCalls.push(signal);
                },
                onData: () => {},
                onExit: () => {},
              });
            };
          }),
        mkdirSync: () => {},
        writeFileSync: () => {},
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        renameSync: () => {},
        createWriteStream: () => ({
          on: () => {},
          write: () => {},
          end: () => {},
        }),
        fetch: async (url) => {
          if (String(url).includes("/api/projects/")) {
            return { ok: true, json: async () => ({ metadata: null }) };
          }
          if (String(url).endsWith("/api/tasks")) {
            return { ok: true, json: async () => [] };
          }
          return { ok: true, json: async () => ({}) };
        },
        createWebSocketClient: () => ({
          registerHandler: (nextHandler) => {
            handler = nextHandler;
          },
          connect: async () => {},
          disconnect: async () => {},
          sendJson: async (payload) => {
            sentEvents.push(payload);
          },
        }),
      },
    );

    handler({
      type: "create_pty_task",
      payload: {
        task_id: "task-shutdown-late-pty",
        project_id: "proj-shutdown-late-pty",
        pty_session_id: "pty-session-shutdown-late",
        request_id: "req-shutdown-late-pty",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    daemonInstance.close();
    resolvePty();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepStrictEqual(killCalls, ["SIGTERM"]);
    assert.strictEqual(
      sentEvents.some((entry) => entry.type === "terminal_opened" && entry.payload?.task_id === "task-shutdown-late-pty"),
      false,
    );
    expectEvent(sentEvents, "terminal_error", (payload) => {
      assert.strictEqual(payload.task_id, "task-shutdown-late-pty");
      assert.strictEqual(payload.message, "daemon shutting down");
    });
  });
});
