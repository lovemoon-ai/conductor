import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import yaml from "js-yaml";

const VALID_ACTIONS = new Set(["list", "run", "status"]);
const MAX_TAIL_CHARS = 12_000;
const MAX_RUNS = 200;
export const CUSTOM_COMMANDS_CAPABILITY = "custom_commands";

/**
 * @typedef {{
 *   key: string;
 *   scriptPath: string;
 * }} CustomCommand
 */

/**
 * @param {object} opts
 * @param {string} [opts.configPath]
 * @param {typeof spawn} [opts.spawnFn]
 */
export function createCustomCommandHandlers(opts = {}) {
  const configPath = opts.configPath || path.join(os.homedir(), ".conductor", "config.yaml");
  const spawnFn = opts.spawnFn || spawn;
  const runs = new Map();
  const runningByKey = new Map();

  async function list() {
    const commands = await loadCustomCommands(configPath);
    return {
      commands: commands.map((command) => {
        const runId = runningByKey.get(command.key) || null;
        return {
          key: command.key,
          running: Boolean(runId),
          ...(runId ? { runId } : {}),
        };
      }),
    };
  }

  async function run(args = {}) {
    const key = normalizeCommandKey(args.key);
    if (!key) {
      throw new Error("run requires a `key` string");
    }
    const existingRunId = runningByKey.get(key);
    if (existingRunId) {
      const existing = runs.get(existingRunId);
      throw new Error(`custom command ${key} is already running as ${existing?.runId || existingRunId}`);
    }

    const commands = await loadCustomCommands(configPath);
    const command = commands.find((entry) => entry.key === key);
    if (!command) {
      throw new Error(`custom command not found: ${key}`);
    }
    await validateScript(command.scriptPath);

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const runState = {
      runId,
      key,
      status: "running",
      pid: null,
      exitCode: null,
      signal: null,
      stdoutTail: "",
      stderrTail: "",
      error: null,
      startedAt,
      finishedAt: null,
    };
    rememberRun(runs, runState);
    runningByKey.set(key, runId);

    const child = spawnFn(command.scriptPath, [], {
      cwd: path.dirname(command.scriptPath),
      env: buildScriptEnv(configPath, key),
      stdio: ["ignore", "pipe", "pipe"],
    });

    runState.pid = typeof child.pid === "number" ? child.pid : null;

    child.stdout?.on("data", (chunk) => {
      runState.stdoutTail = appendTail(runState.stdoutTail, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      runState.stderrTail = appendTail(runState.stderrTail, chunk);
    });
    child.on("error", (error) => {
      finishRun(runState, runningByKey, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code, signal) => {
      finishRun(runState, runningByKey, code === 0 ? "completed" : "failed", {
        exitCode: typeof code === "number" ? code : null,
        signal: signal || null,
      });
    });

    return toPublicRun(runState, { includeOutput: false, started: true });
  }

  async function status(args = {}) {
    const runId = typeof args.runId === "string" ? args.runId.trim() : "";
    if (!runId) {
      throw new Error("status requires a `runId` string");
    }
    const runState = runs.get(runId);
    if (!runState) {
      throw new Error(`custom command run not found: ${runId}`);
    }
    return toPublicRun(runState, { includeOutput: true });
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
        case "list":
          return { result: await list() };
        case "run":
          return { result: await run(payload?.args ?? {}) };
        case "status":
          return { result: await status(payload?.args ?? {}) };
        default:
          return { error: `unhandled action: ${action}` };
      }
    } catch (err) {
      return { error: errMsg(err) };
    }
  }

  return { dispatch, configPath, runs, runningByKey };
}

/**
 * @param {object} client
 * @param {ReturnType<typeof createCustomCommandHandlers>} handlers
 * @param {object} payload
 */
export async function handleCustomCommandsRequest(client, handlers, payload) {
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
    type: "custom_commands_response",
    payload: {
      request_id: requestId,
      action,
      ...(response?.error ? { error: response.error } : { result: response?.result }),
    },
  };
  await client.sendJson(outgoing).catch(() => {});
  return response;
}

/**
 * @param {string} configPath
 * @returns {Promise<CustomCommand[]>}
 */
export async function loadCustomCommands(configPath) {
  let raw = "";
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const parsed = yaml.load(raw);
  return parseCustomCommandsConfig(parsed, configPath);
}

/**
 * @param {unknown} config
 * @param {string} configPath
 * @returns {CustomCommand[]}
 */
export function parseCustomCommandsConfig(config, configPath = path.join(os.homedir(), ".conductor", "config.yaml")) {
  const root = config && typeof config === "object" ? config : {};
  const rawCommands = root.custom_commands;
  if (rawCommands === undefined || rawCommands === null) {
    return [];
  }
  if (Array.isArray(rawCommands) || typeof rawCommands !== "object") {
    throw new Error("custom_commands must be a mapping from key to script path");
  }

  const commands = [];
  const seen = new Set();
  for (const [rawKey, rawValue] of Object.entries(rawCommands)) {
    const key = normalizeCommandKey(rawKey);
    if (!key) {
      throw new Error("custom_commands contains an invalid empty key");
    }
    if (seen.has(key)) {
      throw new Error(`duplicate custom command key: ${key}`);
    }
    seen.add(key);
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      throw new Error(`custom command ${key} must point to a script path string`);
    }
    commands.push({
      key,
      scriptPath: resolveScriptPath(rawValue, configPath),
    });
  }
  return commands;
}

export function normalizeCommandKey(value) {
  if (typeof value !== "string") {
    return "";
  }
  const key = value.trim();
  if (!key || key.length > 80 || /[\x00-\x1F\x7F/\\]/.test(key)) {
    return "";
  }
  return key;
}

function resolveScriptPath(value, configPath) {
  const raw = value.trim();
  const expanded = raw === "~" || raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(path.dirname(configPath), expanded);
}

async function validateScript(scriptPath) {
  let stat;
  try {
    stat = await fsp.stat(scriptPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`custom command script not found: ${scriptPath}`);
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`custom command script is not a file: ${scriptPath}`);
  }
  try {
    await fsp.access(scriptPath, fs.constants.X_OK);
  } catch {
    throw new Error(`custom command script is not executable: ${scriptPath}`);
  }
}

function rememberRun(runs, runState) {
  runs.set(runState.runId, runState);
  while (runs.size > MAX_RUNS) {
    const oldest = [...runs.values()].find((entry) => entry.status !== "running")?.runId;
    if (!oldest) break;
    runs.delete(oldest);
  }
}

function finishRun(runState, runningByKey, status, updates = {}) {
  if (runState.status !== "running") {
    return;
  }
  runState.status = status;
  runState.finishedAt = new Date().toISOString();
  runState.exitCode = updates.exitCode ?? runState.exitCode;
  runState.signal = updates.signal ?? runState.signal;
  runState.error = updates.error ?? runState.error;
  runningByKey.delete(runState.key);
}

function appendTail(current, chunk) {
  const next = current + String(chunk);
  return next.length > MAX_TAIL_CHARS ? next.slice(next.length - MAX_TAIL_CHARS) : next;
}

function buildScriptEnv(configPath, key) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("CONDUCTOR_")) {
      delete env[name];
    }
  }
  env.CONDUCTOR_CONFIG_FILE = configPath;
  env.CONDUCTOR_CUSTOM_COMMAND_KEY = key;
  return env;
}

function toPublicRun(runState, { includeOutput, started = false } = {}) {
  return {
    ...(started ? { started: true } : {}),
    runId: runState.runId,
    key: runState.key,
    status: runState.status,
    pid: runState.pid,
    exitCode: runState.exitCode,
    signal: runState.signal,
    error: runState.error,
    startedAt: runState.startedAt,
    finishedAt: runState.finishedAt,
    ...(includeOutput ? {
      stdoutTail: runState.stdoutTail,
      stderrTail: runState.stderrTail,
    } : {}),
  };
}

function errMsg(err) {
  return err?.message ?? String(err);
}
