import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";

/**
 * Goal-mode capability typedefs shared by AI SDK providers that implement
 * the optional {@link runGoal} method.
 *
 * Callers should treat goal support as opt-in: detect with
 * `typeof session.runGoal === "function"`. When unsupported, do NOT silently
 * fall back to {@link runTurn} — surface a clear error instead.
 *
 * Session creation may also accept `{ goalMode: true }` so the underlying
 * transport can adjust its spawn arguments (e.g. Codex app-server requires
 * `--enable goals` at boot time; dynamic enablement is not supported).
 *
 * @typedef {"active"|"paused"|"blocked"|"usageLimited"|"budgetLimited"|"complete"} GoalStatus
 *
 * @typedef {Object} GoalRequest
 * @property {string} objective
 * @property {number|null} [tokenBudget]
 * @property {{ type: "issue"|"manual", issueId?: string, taskId?: string }} [source]
 *
 * @typedef {Object} GoalState
 * @property {string} [id]
 * @property {string} [threadId]
 * @property {string} objective
 * @property {GoalStatus} status
 * @property {number|null} [tokenBudget]
 *
 * @typedef {Object} GoalResult
 * @property {string} text
 * @property {GoalState} goal
 * @property {unknown} [usage]
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * Runtime list of valid {@link GoalStatus} values. Useful for validation.
 * Terminal statuses are everything except "active" and "paused".
 * @type {ReadonlyArray<GoalStatus>}
 */
export const GOAL_STATUSES = Object.freeze([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

/**
 * Terminal goal statuses (the goal will not produce further updates).
 * @type {ReadonlyArray<GoalStatus>}
 */
export const TERMINAL_GOAL_STATUSES = Object.freeze([
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

/**
 * @param {unknown} value
 * @returns {value is GoalStatus}
 */
export function isGoalStatus(value) {
  return typeof value === "string" && GOAL_STATUSES.includes(/** @type {GoalStatus} */ (value));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTerminalGoalStatus(value) {
  return typeof value === "string" && TERMINAL_GOAL_STATUSES.includes(/** @type {GoalStatus} */ (value));
}

/**
 * Session capability flags advertised in {@link SessionSnapshot.capabilities}.
 *
 * Providers may declare optional features (e.g. `goal`) so that callers can
 * detect support without reflecting on method names (which is unreliable when
 * a wrapping proxy unconditionally forwards every method).
 *
 * @typedef {Object} SessionCapabilities
 * @property {boolean} [goal]
 * @property {boolean} [compact]
 * @property {boolean} [clear]
 */

/**
 * Manual context compaction (`/compact`) contract for providers that
 * implement the optional `runCompact` method and advertise
 * `capabilities.compact === true`. Providers must NOT emit assistant messages
 * while compacting; the caller renders the user-facing confirmation.
 *
 * @typedef {Object} CompactRequest
 * @property {string} [instructions] Optional focus instructions; providers
 *   whose backend cannot take them ignore them and report
 *   `instructionsApplied: false`.
 *
 * @typedef {Object} CompactState
 * @property {"compacted"|"noop"} status `noop` = nothing to compact.
 * @property {boolean} instructionsApplied
 * @property {number} [preTokens]
 * @property {number} [postTokens]
 * @property {number} [tokensRemoved]
 *
 * @typedef {Object} CompactResult
 * @property {CompactState} compact
 * @property {unknown} [usage]
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * Native context clear (`/clear`) contract for providers that implement the
 * optional `runClear` method and advertise `capabilities.clear === true`.
 * Providers must NOT emit assistant messages while clearing; the caller
 * renders the user-facing confirmation.
 *
 * @typedef {Object} ClearState
 * @property {"cleared"|"noop"} status `noop` = there was nothing to clear.
 * @property {string} [sessionId] New session id when the backend starts a new
 *   conversation; callers rebind the task to it.
 *
 * @typedef {Object} ClearResult
 * @property {ClearState} clear
 * @property {unknown} [usage]
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * Default capabilities assigned to providers that do not opt into any optional
 * feature. Treat the returned object as read-only; clone before mutating.
 *
 * @type {Readonly<SessionCapabilities>}
 */
export const DEFAULT_SESSION_CAPABILITIES = Object.freeze({ goal: false, compact: false, clear: false });

/**
 * Resolve a session's capability snapshot, falling back to
 * {@link DEFAULT_SESSION_CAPABILITIES}.
 *
 * @param {unknown} session
 * @returns {SessionCapabilities}
 */
export function resolveSessionCapabilities(session) {
  if (session && typeof session === "object") {
    const obj = /** @type {Record<string, unknown>} */ (session);
    if (typeof obj.getCapabilities === "function") {
      const raw = /** @type {() => unknown} */ (obj.getCapabilities).call(session);
      if (raw && typeof raw === "object") {
        return { ...DEFAULT_SESSION_CAPABILITIES, ...raw };
      }
    }
    const constructor = /** @type {{ capabilities?: unknown }} */ (
      (session.constructor && typeof session.constructor === "function"
        ? session.constructor
        : null) || {}
    );
    if (constructor && constructor.capabilities && typeof constructor.capabilities === "object") {
      return { ...DEFAULT_SESSION_CAPABILITIES, ...constructor.capabilities };
    }
  }
  return { ...DEFAULT_SESSION_CAPABILITIES };
}

export function normalizeLogger(logger) {
  if (typeof logger === "function") {
    return { log: logger };
  }
  if (logger && typeof logger === "object") {
    return logger;
  }
  return {};
}

export function emitLog(logger, message) {
  if (typeof logger?.log !== "function") {
    return;
  }
  try {
    logger.log(message);
  } catch {
    // best effort
  }
}

export function truncateText(value, maxLen = 240) {
  if (!value) return "";
  const text = String(value).trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

export function sanitizeForLog(value, maxLen = 180) {
  if (!value) return "";
  return truncateText(String(value).replace(/\s+/g, " ").trim(), maxLen);
}

const TOOL_INPUT_SUMMARY_KEYS = ["command", "cmd", "file_path", "filePath", "path", "pattern", "query", "url", "description", "prompt"];

function summarizeToolInput(input) {
  let value = input;
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      // keep the raw string
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const key = TOOL_INPUT_SUMMARY_KEYS.find((candidate) => value[candidate]);
    value = key ? value[key] : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    value = value.join(" ");
  }
  return sanitizeForLog(value, 200) || undefined;
}

/**
 * Track tool calls that started but have not finished on a turn object, so
 * `getCurrentTurnStatus()` can report what a long silent turn is running.
 */
export function noteToolStarted(turn, id, name, input) {
  if (!turn || !id || !name) {
    return;
  }
  turn.activeTools ||= new Map();
  const key = String(id);
  if (turn.activeTools.has(key)) {
    return;
  }
  turn.activeTools.set(key, {
    name: String(name),
    summary: summarizeToolInput(input),
    started_at: new Date().toISOString(),
  });
}

export function noteToolFinished(turn, id) {
  if (id) {
    turn?.activeTools?.delete(String(id));
  }
}

/** Map a codex app-server (camelCase) or exec (snake_case) tool item to `{ name, input }`. */
export function describeCodexToolItem(item) {
  switch (String(item?.type || "").replace(/_/g, "").toLowerCase()) {
    case "commandexecution":
      return { name: "command", input: item.command };
    case "filechange":
      return { name: "apply_patch", input: (item.changes || []).map((change) => change?.path).join(" ") };
    case "mcptoolcall":
      return { name: [item.server, item.tool].filter(Boolean).join("."), input: item.arguments };
    case "dynamictoolcall":
    case "collabagenttoolcall":
      return { name: item.tool, input: item.arguments ?? item.prompt };
    case "websearch":
      return { name: "web_search", input: item.query };
    default:
      return null;
  }
}

export function withActiveTool(status, turn) {
  if (!status) {
    return null;
  }
  const tools = turn?.activeTools ? [...turn.activeTools.values()] : [];
  const activeTool = tools[tools.length - 1];
  return activeTool ? { ...status, active_tool: { ...activeTool } } : { ...status };
}

export function isTruthyEnv(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function getBoundedEnvInt(envName, fallback, min, max) {
  const fallbackNumber = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackNumber)
    ? Math.min(Math.max(Math.round(fallbackNumber), min), max)
    : min;
  const raw = process.env[envName];
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return normalizedFallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

export function parseCommandParts(commandLine) {
  const normalized = String(commandLine || "").trim();
  if (!normalized) {
    return { command: "", args: [] };
  }
  const parts = [];
  let current = "";
  let quote = "";
  let tokenStarted = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const nextChar = normalized[index + 1];

    if (quote === "'") {
      if (char === "'") {
        quote = "";
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = "";
        continue;
      }
      if (char === "\\") {
        if (nextChar === "\"" || nextChar === "\\") {
          current += nextChar;
          tokenStarted = true;
          index += 1;
          continue;
        }
        current += "\\";
        tokenStarted = true;
        continue;
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (char === "\\") {
      if (nextChar && (/\s/.test(nextChar) || nextChar === "\"" || nextChar === "'" || nextChar === "\\")) {
        current += nextChar;
        tokenStarted = true;
        index += 1;
        continue;
      }
      current += "\\";
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        parts.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error(`Invalid command line: unterminated ${quote === "\"" ? "double" : "single"} quote`);
  }

  if (tokenStarted) {
    parts.push(current);
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

// Read a long-flag value (`--flag value` or `--flag=value`) out of an
// allow_cli_list command string. Returns "" if absent or empty. Provider
// session classes use this to lift backend-specific flags (e.g. claude's
// `--effort`, codex's `-c`) out of the configured command without having to
// bubble them up through the fire/serve-ai layers.
export function extractLongFlagFromCommandLine(commandLine, flag) {
  const normalized = typeof flag === "string" ? flag.trim() : "";
  if (!normalized) {
    return "";
  }
  let parts;
  try {
    const { command, args } = parseCommandParts(commandLine);
    parts = command ? [command, ...args] : [];
  } catch {
    return "";
  }
  const longFlag = `--${normalized}`;
  const longFlagEq = `${longFlag}=`;
  for (let index = 0; index < parts.length; index += 1) {
    const token = String(parts[index] || "").trim();
    if (!token) {
      continue;
    }
    if (token === longFlag) {
      const next = String(parts[index + 1] || "").trim();
      return next || "";
    }
    if (token.startsWith(longFlagEq)) {
      return token.slice(longFlagEq.length).trim();
    }
  }
  return "";
}

export function resolveConductorConfigPath(configFilePath) {
  if (configFilePath) {
    return configFilePath;
  }
  const userHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (typeof process.env.CONDUCTOR_CONFIG === "string" && process.env.CONDUCTOR_CONFIG.trim()) {
    const configuredPath = process.env.CONDUCTOR_CONFIG.trim();
    const expandedPath = configuredPath === "~"
      ? userHome
      : configuredPath.startsWith("~/") || configuredPath.startsWith("~\\")
        ? path.join(userHome, configuredPath.slice(2))
        : configuredPath;
    return path.resolve(expandedPath);
  }
  const configuredHome =
    typeof process.env.CONDUCTOR_HOME === "string" ? process.env.CONDUCTOR_HOME.trim() : "";
  if (configuredHome) {
    const expandedHome = configuredHome === "~"
      ? userHome
      : configuredHome.startsWith("~/") || configuredHome.startsWith("~\\")
        ? path.join(userHome, configuredHome.slice(2))
        : configuredHome;
    return path.join(path.resolve(expandedHome), "config.yaml");
  }
  return path.join(userHome, ".conductor", "config.yaml");
}

export function loadYamlConfig(configFilePath) {
  try {
    const configPath = resolveConductorConfigPath(configFilePath);
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = yaml.load(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function loadAllowCliList(configFilePath) {
  const parsed = loadYamlConfig(configFilePath);
  if (parsed && parsed.allow_cli_list && typeof parsed.allow_cli_list === "object") {
    return parsed.allow_cli_list;
  }
  return {};
}

export function loadEnvConfig(configFilePath) {
  const parsed = loadYamlConfig(configFilePath);
  if (parsed && parsed.envs && typeof parsed.envs === "object") {
    return parsed.envs;
  }
  return null;
}

export function proxyToEnv(envConfig) {
  if (!envConfig || typeof envConfig !== "object") {
    return {};
  }
  const env = {};
  const mappings = {
    http_proxy: ["HTTP_PROXY", "http_proxy"],
    https_proxy: ["HTTPS_PROXY", "https_proxy"],
    all_proxy: ["ALL_PROXY", "all_proxy"],
    no_proxy: ["NO_PROXY", "no_proxy"],
  };
  for (const [key, envKeys] of Object.entries(mappings)) {
    const value = envConfig[key] || envConfig[key.toUpperCase()];
    if (!value) {
      continue;
    }
    for (const envKey of envKeys) {
      env[envKey] = value;
    }
  }
  return env;
}

export function withoutCopilotGithubTokenEnv(env) {
  const next = env && typeof env === "object" ? { ...env } : {};
  for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    delete next[key];
  }
  return next;
}

export function serializeError(error) {
  if (error instanceof Error) {
    const payload = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    for (const key of Object.keys(error)) {
      payload[key] = error[key];
    }
    return payload;
  }
  if (error && typeof error === "object") {
    return { ...error, message: String(error.message || "Unknown error") };
  }
  return { message: String(error || "Unknown error") };
}

export function reviveError(payload) {
  const error = new Error(String(payload?.message || "Unknown error"));
  if (payload && typeof payload === "object") {
    if (payload.name) {
      error.name = String(payload.name);
    }
    if (payload.stack) {
      error.stack = String(payload.stack);
    }
    for (const [key, value] of Object.entries(payload)) {
      if (key === "name" || key === "message" || key === "stack") {
        continue;
      }
      error[key] = value;
    }
  }
  return error;
}
