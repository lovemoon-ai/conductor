import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveConductorHome } from "./conductor-paths.js";
import { DAEMON_LOCK_FILE_NAME, parseDaemonLockState } from "./daemon-lock.js";
import {
  PACKAGE_NAME,
  detectPackageManager,
  fetchLatestVersion,
  isNewerVersion,
  resolveGlobalInstallPrefix,
} from "./version-check.js";
import {
  buildPnpmAllowBuildArgs,
  ensurePnpmOnlyBuiltDependencies,
  repairAndVerifyGlobalNodePty,
  resolveGlobalPackageDirectory,
} from "./native-deps.js";

/**
 * Built-in "Update Daemon": upgrade the globally installed CLI and restart the
 * daemon onto it.
 *
 * The one invariant this module exists to uphold is that a *failed* update
 * never leaves the machine without a daemon:
 *
 *  1. The work runs in a DETACHED updater process, not inside the daemon. The
 *     daemon it is about to replace can therefore die (or be killed) without
 *     taking the update with it, and a crashing update cannot take the daemon
 *     down with it either.
 *  2. Install and verification happen FIRST. The running daemon is only
 *     stopped once the new version is on disk, reports the expected version,
 *     and passes the node-pty native check. Any failure before that point
 *     aborts with the old daemon still running and still serving tasks.
 *  3. Progress is journaled to a status file, so the answer survives the
 *     restart and can be read back by whichever daemon is alive afterwards.
 */
export const UPDATE_DAEMON_CAPABILITY = "update_daemon";

const STATUS_FILE_NAME = "daemon-update.json";
const UPDATE_LOG_FILE_NAME = "daemon-update.log";
const MAX_LOG_TAIL_CHARS = 12_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const VERSION_CHECK_TIMEOUT_MS = 30_000;
const STOP_DAEMON_TIMEOUT_MS = 60_000;
const START_DAEMON_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 300;

export function resolveDaemonUpdatePaths(env = process.env) {
  const home = resolveConductorHome(env);
  return {
    statusPath: path.join(home, "state", STATUS_FILE_NAME),
    logPath: path.join(home, "logs", UPDATE_LOG_FILE_NAME),
  };
}

export function readDaemonUpdateStatus(statusPath, { readFileSync = fs.readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(statusPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDaemonUpdateStatus(
  statusPath,
  status,
  { mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync } = {},
) {
  try {
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, JSON.stringify(status));
  } catch {
    // A journal we cannot write must not abort the update itself.
  }
}

function isProcessAlive(pid, killFn = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another OS user.
    return error?.code !== "ESRCH";
  }
}

/**
 * A status file left behind by an updater that died (machine reboot, SIGKILL)
 * would otherwise wedge the feature at "running" forever.
 */
function isUpdateStillRunning(status, killFn = process.kill) {
  if (status?.status !== "running") return false;
  if (!status.updaterPid) return true;
  return isProcessAlive(status.updaterPid, killFn);
}

export function createDaemonUpdateHandlers({
  statusPath,
  logPath,
  updaterScript,
  updaterParams,
  spawnFn = spawn,
  killFn = process.kill.bind(process),
  readStatus = readDaemonUpdateStatus,
  writeStatus = writeDaemonUpdateStatus,
  refuseReason = null,
  env = process.env,
} = {}) {
  function status() {
    const current = readStatus(statusPath);
    if (!current) {
      return { status: "idle", runId: null, logPath };
    }
    if (current.status === "running" && !isUpdateStillRunning(current, killFn)) {
      return {
        ...current,
        status: "failed",
        error: current.error || "updater process exited without reporting a result",
      };
    }
    return current;
  }

  function start() {
    if (refuseReason) {
      throw new Error(refuseReason);
    }
    const current = readStatus(statusPath);
    if (isUpdateStillRunning(current, killFn)) {
      throw new Error(`daemon update already running (run ${current.runId})`);
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const params = { ...updaterParams, runId, statusPath, logPath };

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, "a");
    let child;
    try {
      // `detached` is the whole point: the updater gets its own process group,
      // so stopping the daemon (step 3 of the update) cannot kill the process
      // that is performing the update.
      child = spawnFn(process.execPath, [updaterScript, JSON.stringify(params)], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        // The package directory is about to be replaced by the installer; a
        // cwd inside it would be pulled out from under the updater.
        cwd: os.tmpdir(),
        env: { ...env },
      });
      child.unref?.();
    } finally {
      try {
        fs.closeSync(logFd);
      } catch {
        // ignore
      }
    }

    const pending = {
      runId,
      status: "running",
      phase: "starting",
      message: "Update starting",
      fromVersion: updaterParams?.currentVersion ?? null,
      toVersion: null,
      error: null,
      logPath,
      updaterPid: typeof child?.pid === "number" ? child.pid : null,
      daemonRestarted: false,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      log: "",
    };
    writeStatus(statusPath, pending);
    return pending;
  }

  async function dispatch(payload) {
    const action = payload?.action;
    try {
      switch (action) {
        case "start":
          return { result: start() };
        case "status":
          return { result: status() };
        default:
          return { error: `unknown action: ${action}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { dispatch, statusPath, logPath };
}

export async function handleUpdateDaemonRequest(client, handlers, payload) {
  const requestId = payload?.request_id ? String(payload.request_id) : "";
  const action = payload?.action ? String(payload.action) : "";
  if (!requestId) {
    return { error: "missing request_id" };
  }

  const response = await handlers.dispatch({ action });
  await client
    .sendJson({
      type: "update_daemon_response",
      payload: {
        request_id: requestId,
        action,
        ...(response?.error ? { error: response.error } : { result: response?.result }),
      },
    })
    .catch(() => {});
  return response;
}

// ---------------------------------------------------------------------------
// Updater process
// ---------------------------------------------------------------------------

function defaultRunCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
      cwd: options.cwd || os.tmpdir(),
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, options.timeoutMs ?? 120_000);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 16_000) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16_000) stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0, code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ success: false, code: -1, stdout, stderr: error?.message || String(error) });
    });
  });
}

function buildInstallCommand(packageManager, pkgSpec) {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", ...buildPnpmAllowBuildArgs(["node-pty"]), pkgSpec] };
    case "yarn":
      return { command: "yarn", args: ["global", "add", pkgSpec] };
    default:
      return { command: "npm", args: ["install", "-g", pkgSpec] };
  }
}

function buildUninstallCommand(packageManager, packageName) {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["remove", "-g", packageName] };
    case "yarn":
      return { command: "yarn", args: ["global", "remove", packageName] };
    default:
      return { command: "npm", args: ["uninstall", "-g", packageName] };
  }
}

/**
 * `npm install -g` targets whichever npm wins the PATH lookup, which is not
 * necessarily the one that installed us. Pin it to the prefix the running
 * package actually lives in, exactly like `conductor update` does.
 */
function buildInstallEnv(packageManager, packageRoot, env) {
  const installEnv = { ...env };
  if (packageManager === "npm") {
    const prefix = resolveGlobalInstallPrefix(packageRoot);
    if (prefix) installEnv.npm_config_prefix = prefix;
  }
  return installEnv;
}

export async function runDaemonUpdate(params = {}, deps = {}) {
  const {
    runId = randomUUID(),
    statusPath,
    logPath = null,
    packageRoot,
    packageName = PACKAGE_NAME,
    launcherScript,
    launcherArgs = [],
    versionCheckScript = null,
    versionCheckArgs = ["--version"],
    daemonPid = null,
    lockFile,
    daemonLogPath = null,
    currentVersion = "unknown",
    env = process.env,
  } = params;

  const runCommand = deps.runCommand || defaultRunCommand;
  const spawnFn = deps.spawn || spawn;
  const killFn = deps.kill || process.kill.bind(process);
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const rmSync = deps.rmSync || fs.rmSync;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());
  const writeStatus = deps.writeStatus || writeDaemonUpdateStatus;
  const fetchLatestVersionFn = deps.fetchLatestVersion || fetchLatestVersion;
  const detectPackageManagerFn = deps.detectPackageManager || detectPackageManager;
  const repairAndVerifyNodePty = deps.repairAndVerifyGlobalNodePty || repairAndVerifyGlobalNodePty;
  const ensurePnpmAllowlist = deps.ensurePnpmOnlyBuiltDependencies || ensurePnpmOnlyBuiltDependencies;
  const writeLine = deps.writeLine || ((line) => process.stdout.write(`${line}\n`));

  const startedAt = new Date().toISOString();
  const state = {
    runId,
    status: "running",
    phase: "resolving",
    message: "Resolving latest version",
    fromVersion: currentVersion,
    toVersion: null,
    error: null,
    logPath,
    updaterPid: process.pid,
    daemonRestarted: false,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    log: "",
  };

  const log = (line) => {
    const text = `==> ${line}`;
    writeLine(text);
    state.log = `${state.log}${text}\n`.slice(-MAX_LOG_TAIL_CHARS);
  };
  const publish = (updates = {}) => {
    Object.assign(state, updates, { updatedAt: new Date().toISOString() });
    if (statusPath) writeStatus(statusPath, state);
  };
  const finish = (updates) => {
    publish({ ...updates, finishedAt: new Date().toISOString() });
    return { ...state };
  };
  let daemonStopped = false;
  const fail = (message) => {
    log(`FAILED: ${message}`);
    log(
      daemonStopped
        ? "the daemon was already stopped for the restart; start it again on this machine"
        : "daemon was left running on the current version",
    );
    return finish({ status: "failed", phase: "done", message: "Update failed", error: message });
  };

  log(`current version: ${currentVersion}`);
  publish({});

  // --- 1. Resolve the target version -------------------------------------
  let latestVersion;
  try {
    latestVersion = await fetchLatestVersionFn(packageName);
  } catch (error) {
    return fail(`could not reach the npm registry: ${error?.message || error}`);
  }
  if (!latestVersion) {
    return fail("could not resolve the latest version from the npm registry");
  }
  log(`latest version: ${latestVersion}`);
  if (!isNewerVersion(latestVersion, currentVersion)) {
    log("already up to date; daemon left untouched");
    return finish({
      status: "completed",
      phase: "done",
      toVersion: currentVersion,
      message: `Already on the latest version (${currentVersion})`,
    });
  }

  // --- 2. Install ---------------------------------------------------------
  const packageManager = detectPackageManagerFn({
    launcherPath: versionCheckScript || launcherScript,
    packageRoot,
  });
  const pkgSpec = `${packageName}@${latestVersion}`;
  const installEnv = buildInstallEnv(packageManager, packageRoot, env);
  publish({
    phase: "installing",
    toVersion: latestVersion,
    message: `Installing ${pkgSpec} via ${packageManager}`,
  });

  if (packageManager === "pnpm") {
    try {
      await ensurePnpmAllowlist({ runCommand, dependencies: ["node-pty"], global: true });
    } catch (error) {
      log(`could not prepare the pnpm build allowlist: ${error?.message || error}`);
    }
  }

  const install = buildInstallCommand(packageManager, pkgSpec);
  const runInstall = () =>
    runCommand(install.command, install.args, { env: installEnv, timeoutMs: INSTALL_TIMEOUT_MS });

  log(`${install.command} ${install.args.join(" ")}`);
  let installResult = await runInstall();
  if (!installResult.success) {
    // A half-removed global install makes npm fail with ENOTEMPTY forever.
    // Clear it out and try once more before giving up.
    log(`install failed (exit ${installResult.code}); removing the broken install and retrying`);
    log(String(installResult.stderr || installResult.stdout || "").trim().slice(-800));
    const uninstall = buildUninstallCommand(packageManager, packageName);
    await runCommand(uninstall.command, uninstall.args, { env: installEnv, timeoutMs: INSTALL_TIMEOUT_MS });
    try {
      const packageDirectory = await resolveGlobalPackageDirectory({
        packageManager,
        packageName,
        runCommand: (command, args, options) => runCommand(command, args, { env: installEnv, ...options }),
      });
      rmSync(packageDirectory, { recursive: true, force: true });
      log(`removed ${packageDirectory}`);
    } catch (error) {
      log(`could not remove the global package directory: ${error?.message || error}`);
    }
    installResult = await runInstall();
  }
  if (!installResult.success) {
    return fail(
      `install failed (exit ${installResult.code}): ${String(installResult.stderr || installResult.stdout || "")
        .trim()
        .slice(-500)}`,
    );
  }

  // --- 3. Verify BEFORE touching the running daemon -----------------------
  publish({ phase: "verifying", message: `Verifying ${latestVersion}` });

  const installedVersion = await readInstalledVersion({
    runCommand,
    readFileSync,
    versionCheckScript,
    versionCheckArgs,
    launcherScript,
    packageRoot,
    env: installEnv,
  });
  if (installedVersion !== latestVersion) {
    return fail(`version mismatch after install: expected ${latestVersion}, got ${installedVersion || "unknown"}`);
  }

  try {
    await repairAndVerifyNodePty({
      packageManager,
      packageName,
      runCommand: (command, args, options) => runCommand(command, args, { env: installEnv, ...options }),
      nodeExecutable: process.execPath,
    });
  } catch (error) {
    return fail(`native dependency verification failed: ${error?.message || error}`);
  }
  log(`installed and verified ${latestVersion}`);

  // --- 4. Restart the daemon onto the new version -------------------------
  if (!launcherScript) {
    return fail("installed the new version but no daemon launcher is known, so the daemon was not restarted");
  }
  publish({ phase: "restarting", message: `Restarting daemon on ${latestVersion}` });

  if (daemonPid && isProcessAlive(daemonPid, killFn)) {
    log(`stopping daemon (PID ${daemonPid})`);
    try {
      killFn(daemonPid, "SIGTERM");
    } catch (error) {
      log(`SIGTERM failed: ${error?.message || error}`);
    }
    const stopped = await waitFor(
      () => !isProcessAlive(daemonPid, killFn),
      STOP_DAEMON_TIMEOUT_MS,
      { sleep, now },
    );
    if (!stopped) {
      log(`daemon did not exit within ${STOP_DAEMON_TIMEOUT_MS}ms; sending SIGKILL`);
      try {
        killFn(daemonPid, "SIGKILL");
      } catch {
        // ignore
      }
      await waitFor(() => !isProcessAlive(daemonPid, killFn), 5_000, { sleep, now });
    }
    daemonStopped = true;
  }

  // `--force` lets the fresh daemon take over the lock even if the outgoing one
  // had to be SIGKILLed and never cleaned it up.
  const args = launcherArgs.includes("--force") ? launcherArgs : [...launcherArgs, "--force"];
  let logFd = null;
  try {
    if (daemonLogPath) {
      fs.mkdirSync(path.dirname(daemonLogPath), { recursive: true });
      logFd = fs.openSync(daemonLogPath, "a");
    }
    const child = spawnFn(process.execPath, [launcherScript, ...args], {
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      cwd: os.tmpdir(),
      env: { ...env },
    });
    child.unref?.();
    log(`started daemon (PID ${child?.pid ?? "unknown"}): ${launcherScript} ${args.join(" ")}`);
  } catch (error) {
    return fail(`installed ${latestVersion} but failed to start the new daemon: ${error?.message || error}`);
  } finally {
    if (typeof logFd === "number") {
      try {
        fs.closeSync(logFd);
      } catch {
        // ignore
      }
    }
  }

  const cameUp = await waitFor(
    () => {
      const lockState = parseDaemonLockState(safeRead(readFileSync, lockFile));
      const pid = lockState?.pid;
      return Boolean(pid) && pid !== daemonPid && isProcessAlive(pid, killFn);
    },
    START_DAEMON_TIMEOUT_MS,
    { sleep, now },
  );
  if (!cameUp) {
    return fail(
      `installed ${latestVersion} but the new daemon did not come up within ${Math.round(
        START_DAEMON_TIMEOUT_MS / 1000,
      )}s — check ${daemonLogPath || "the daemon log"}`,
    );
  }

  log(`daemon is back up on ${latestVersion}`);
  return finish({
    status: "completed",
    phase: "done",
    daemonRestarted: true,
    message: `Updated ${currentVersion} → ${latestVersion} and restarted the daemon`,
  });
}

function safeRead(readFileSync, filePath) {
  if (!filePath) return "";
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

async function waitFor(predicate, timeoutMs, { sleep, now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function readInstalledVersion({
  runCommand,
  readFileSync,
  versionCheckScript,
  versionCheckArgs,
  launcherScript,
  packageRoot,
  env,
}) {
  const script = versionCheckScript || launcherScript;
  const attempts = script
    ? [{ command: process.execPath, args: [script, ...versionCheckArgs] }]
    : [{ command: "conductor", args: ["--version"] }];

  for (const attempt of attempts) {
    const result = await runCommand(attempt.command, attempt.args, {
      env,
      timeoutMs: VERSION_CHECK_TIMEOUT_MS,
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    const match = combined.match(/conductor version ([^\s]+)/);
    if (match?.[1]) return match[1];
  }

  // Fall back to the package.json the installer just rewrote on disk.
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}
