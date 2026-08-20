import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { resolveUserHome } from "./conductor-paths.js";

const VALID_ACTIONS = new Set(["exec", "status", "cancel"]);
const MAX_TAIL_CHARS = 64_000;
const MAX_RUNS = 200;
const MAX_CONCURRENT_RUNS = 32;
const MAX_ARGS = 256;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 120_000;
/** Grace between SIGTERM and SIGKILL when a run is cancelled. */
const KILL_GRACE_MS = 5_000;
const NUL = String.fromCharCode(0);

export const REMOTE_EXEC_CAPABILITY = "remote_exec";

/**
 * Run arbitrary commands on this daemon's host on behalf of the account that
 * owns it.
 *
 * This is not a new trust boundary: the same account can already reach the same
 * shell through `create_pty_task`, whose `entrypoint_type: "custom"` branch
 * takes a caller-supplied command, argv, cwd and env, and whose server-side
 * validation only checks `cols`/`rows`. The one case where this genuinely does
 * add reach is a host whose node-pty probe failed — there `pty_task` is not
 * advertised at all — which is why the capability is opt-out-able via
 * `remote_exec: false` in the daemon's config.
 *
 * Commands are spawned without a shell: the caller sends argv, so nothing is
 * re-parsed here. Callers that genuinely want a shell pass `-- bash -lc "..."`.
 *
 * @param {object} opts
 * @param {typeof spawn} [opts.spawnFn]
 * @param {string} [opts.defaultWorkspace] cwd used when the request omits one
 */
export function createRemoteExecHandlers(opts = {}) {
  const spawnFn = opts.spawnFn || spawn;
  const defaultWorkspace = opts.defaultWorkspace || resolveUserHome();
  const runs = new Map();

  async function exec(args = {}) {
    // Start the clock before any I/O. The server's waiter starts ticking the
    // moment it sends the request, and its only margin is a few seconds of
    // slack; a slow `stat` on a stale network mount would otherwise let the
    // server time out first, stranding a running child whose runId the caller
    // never learned.
    const waitMs = clampWaitMs(args.timeoutMs ?? args.timeout_ms);
    const waitDeadline = Date.now() + waitMs;

    const command = normalizeCommand(args.command);
    if (!command) {
      throw new Error("exec requires a `command` string");
    }
    const argv = normalizeArgv(args.args);
    const running = countRunning(runs);
    if (running >= MAX_CONCURRENT_RUNS) {
      throw new Error(
        `too many concurrent remote exec runs on this daemon (${running}/${MAX_CONCURRENT_RUNS}); cancel one first`,
      );
    }
    const cwd = await resolveWorkspace(args.workspace ?? args.workspace_path, defaultWorkspace);
    const env = buildExecEnv(args.env);

    const runState = {
      runId: randomUUID(),
      command,
      args: argv,
      workspace: cwd,
      status: "running",
      pid: null,
      exitCode: null,
      signal: null,
      stdoutTail: "",
      stderrTail: "",
      truncated: false,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      settleWaiters: [],
      child: null,
      cancelRequested: false,
      killTimer: null,
    };
    rememberRun(runs, runState);

    let child;
    try {
      child = spawnFn(command, argv, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finishRun(runState, "failed", { error: errMsg(error) });
      return toPublicRun(runState);
    }

    runState.child = child;
    runState.pid = typeof child.pid === "number" ? child.pid : null;

    // Decode per stream: a multi-byte character can straddle two `data` chunks,
    // and a naive String(chunk) would turn each half into U+FFFD.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk) => {
      runState.stdoutTail = appendTail(runState, runState.stdoutTail, stdoutDecoder.write(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      runState.stderrTail = appendTail(runState, runState.stderrTail, stderrDecoder.write(chunk));
    });
    child.on("error", (error) => {
      finishRun(runState, "failed", { error: errMsg(error) });
    });
    child.on("close", (code, signal) => {
      runState.stdoutTail = appendTail(runState, runState.stdoutTail, stdoutDecoder.end());
      runState.stderrTail = appendTail(runState, runState.stderrTail, stderrDecoder.end());
      const status = runState.cancelRequested ? "cancelled" : code === 0 ? "completed" : "failed";
      finishRun(runState, status, {
        exitCode: typeof code === "number" ? code : null,
        signal: signal || null,
      });
    });

    await waitForSettle(runState, Math.max(0, waitDeadline - Date.now()));
    return toPublicRun(runState);
  }

  async function status(args = {}) {
    return toPublicRun(mustFindRun(runs, args.runId));
  }

  async function cancel(args = {}) {
    const runState = mustFindRun(runs, args.runId);
    if (runState.status !== "running") {
      return toPublicRun(runState);
    }
    runState.cancelRequested = true;
    try {
      runState.child?.kill("SIGTERM");
    } catch (error) {
      runState.error = runState.error || errMsg(error);
    }
    // Escalate if the child ignores SIGTERM. The timer is unref'd so it can
    // never hold the daemon's event loop open.
    runState.killTimer = setTimeout(() => {
      try {
        runState.child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    runState.killTimer.unref?.();

    await waitForSettle(runState, KILL_GRACE_MS * 2);
    return toPublicRun(runState);
  }

  /**
   * Run a single action and return a `result` object, never throwing.
   * @param {{action:string,args?:object}} payload
   */
  async function dispatch(payload) {
    const action = payload?.action;
    if (!VALID_ACTIONS.has(action)) {
      return { error: `unknown action: ${action}` };
    }
    try {
      switch (action) {
        case "exec":
          return { result: await exec(payload?.args ?? {}) };
        case "status":
          return { result: await status(payload?.args ?? {}) };
        case "cancel":
          return { result: await cancel(payload?.args ?? {}) };
        default:
          return { error: `unhandled action: ${action}` };
      }
    } catch (err) {
      return { error: errMsg(err) };
    }
  }

  return { dispatch, runs, defaultWorkspace };
}

/**
 * @param {object} client
 * @param {ReturnType<typeof createRemoteExecHandlers>} handlers
 * @param {object} payload
 */
export async function handleRemoteExecRequest(client, handlers, payload) {
  const requestId = payload?.request_id ? String(payload.request_id) : "";
  const action = payload?.action ? String(payload.action) : "";
  if (!requestId) {
    return { error: "missing request_id" };
  }

  const response = await handlers.dispatch({
    action,
    args: payload?.args && typeof payload.args === "object" ? payload.args : {},
  });

  const outgoing = {
    type: "remote_exec_response",
    payload: {
      request_id: requestId,
      action,
      ...(response?.error ? { error: response.error } : { result: response?.result }),
    },
  };
  await client.sendJson(outgoing).catch(() => {});
  return response;
}

function mustFindRun(runs, rawRunId) {
  const runId = typeof rawRunId === "string" ? rawRunId.trim() : "";
  if (!runId) {
    throw new Error("this action requires a `runId` string");
  }
  const runState = runs.get(runId);
  if (!runState) {
    throw new Error(`remote exec run not found: ${runId}`);
  }
  return runState;
}

function countRunning(runs) {
  let count = 0;
  for (const entry of runs.values()) {
    if (entry.status === "running") count += 1;
  }
  return count;
}

export function normalizeCommand(value) {
  if (typeof value !== "string") {
    return "";
  }
  const command = value.trim();
  if (!command || command.includes(NUL)) {
    return "";
  }
  return command;
}

export function normalizeArgv(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("`args` must be an array of strings");
  }
  if (value.length > MAX_ARGS) {
    throw new Error(`\`args\` must contain at most ${MAX_ARGS} entries`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("`args` must contain only strings");
    }
    if (entry.includes(NUL)) {
      throw new Error("`args` must not contain NUL bytes");
    }
    return entry;
  });
}

export async function resolveWorkspace(value, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  const target = raw ? expandHome(raw) : fallback;
  const resolved = path.resolve(target);

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`workspace does not exist: ${resolved}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`workspace is not a directory: ${resolved}`);
  }
  return resolved;
}

function expandHome(raw) {
  if (raw === "~") {
    return resolveUserHome();
  }
  if (raw.startsWith("~/")) {
    return path.join(resolveUserHome(), raw.slice(2));
  }
  return raw;
}

export function clampWaitMs(value) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(Math.trunc(parsed), MAX_WAIT_MS);
}

/**
 * Inherit the daemon environment minus `CONDUCTOR_*`, matching what
 * `custom_commands` does. This keeps the agent token out of the child's env; it
 * is NOT a confidentiality guarantee — the token still sits in
 * `~/.conductor/config.yaml`, which an arbitrary command can simply read. Do
 * not build any security control on top of this.
 */
export function buildExecEnv(overrides) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("CONDUCTOR_")) {
      delete env[name];
    }
  }
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!key || key.includes("=") || key.includes(NUL)) {
        throw new Error(`invalid env variable name: ${key}`);
      }
      if (typeof value !== "string" || value.includes(NUL)) {
        throw new Error(`env variable ${key} must be a string`);
      }
      env[key] = value;
    }
  }
  return env;
}

function waitForSettle(runState, waitMs) {
  if (runState.status !== "running") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = runState.settleWaiters.indexOf(finish);
      if (index >= 0) runState.settleWaiters.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    timer.unref?.();
    runState.settleWaiters.push(finish);
  });
}

function rememberRun(runs, runState) {
  runs.set(runState.runId, runState);
  while (runs.size > MAX_RUNS) {
    const oldest = [...runs.values()].find((entry) => entry.status !== "running")?.runId;
    // Only finished runs are evictable, and `MAX_CONCURRENT_RUNS` bounds how
    // many can be running at once, so the map cannot grow without limit.
    if (!oldest) break;
    runs.delete(oldest);
  }
}

function finishRun(runState, status, updates = {}) {
  if (runState.status !== "running") {
    return;
  }
  runState.status = status;
  runState.finishedAt = new Date().toISOString();
  runState.exitCode = updates.exitCode ?? runState.exitCode;
  runState.signal = updates.signal ?? runState.signal;
  runState.error = updates.error ?? runState.error;
  if (runState.killTimer) {
    clearTimeout(runState.killTimer);
    runState.killTimer = null;
  }
  runState.child = null;
  for (const waiter of runState.settleWaiters.splice(0)) {
    waiter();
  }
}

function appendTail(runState, current, chunk) {
  if (!chunk) {
    return current;
  }
  const next = current + chunk;
  if (next.length <= MAX_TAIL_CHARS) {
    return next;
  }
  runState.truncated = true;
  return next.slice(next.length - MAX_TAIL_CHARS);
}

function toPublicRun(runState) {
  return {
    runId: runState.runId,
    command: runState.command,
    args: runState.args,
    workspace: runState.workspace,
    status: runState.status,
    pid: runState.pid,
    exitCode: runState.exitCode,
    signal: runState.signal,
    error: runState.error,
    startedAt: runState.startedAt,
    finishedAt: runState.finishedAt,
    stdoutTail: runState.stdoutTail,
    stderrTail: runState.stderrTail,
    truncated: runState.truncated,
  };
}

function errMsg(err) {
  return err?.message ?? String(err);
}
