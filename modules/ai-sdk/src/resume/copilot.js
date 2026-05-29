import fs from "node:fs";
import path from "node:path";

import {
  loadAllowCliList,
  loadEnvConfig,
  parseCommandParts,
  proxyToEnv,
  withoutCopilotGithubTokenEnv,
} from "../shared.js";
import {
  buildResumeContext,
  isExistingDirectory,
  normalizeProjectPathCandidate,
  normalizeSessionId,
} from "./shared.js";

export const BACKEND = "copilot";

const LEGACY_COPILOT_CLI_ARGS = new Set(["--allow-all-paths", "--allow-all-tools"]);
const DEFAULT_COPILOT_RESUME_TIMEOUT_MS = 20_000;
const DEFAULT_COPILOT_RESUME_STOP_TIMEOUT_MS = 5_000;
const COPILOT_GITHUB_TOKEN_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

export function buildCliArgs(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  return [`--resume=${normalizedSessionId}`];
}

export async function findSessionPath() {
  // Copilot sessions are managed through the GitHub Copilot SDK; they do not
  // have a local session file path that we can enumerate directly.
  return null;
}

export async function resolveResumeContext(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const sessionMetadata = await withCopilotClient(options, async (client) => {
    const sessions = await client.listSessions();
    return sessions.find((entry) => normalizeSessionId(entry?.sessionId) === normalizedSessionId) || null;
  });
  if (!sessionMetadata) {
    throw new Error(`Invalid --resume session id for copilot: ${normalizedSessionId}`);
  }
  const cwd = normalizeProjectPathCandidate(sessionMetadata?.context?.cwd);
  if (!cwd) {
    throw new Error(`Could not resolve workspace for copilot session ${normalizedSessionId}`);
  }
  if (!(await isExistingDirectory(cwd))) {
    throw new Error(`Resume workspace path does not exist: ${cwd}`);
  }
  return buildResumeContext({
    provider: "copilot",
    sessionId: normalizedSessionId,
    sessionPath: null,
    cwd,
    cwdSource: "sdk_list_sessions",
    extraDebug: {
      context: sessionMetadata?.context && typeof sessionMetadata.context === "object"
        ? { ...sessionMetadata.context }
        : undefined,
    },
  });
}

async function getCopilotSdkModule(options = {}) {
  if (options.copilotSdkModule && typeof options.copilotSdkModule === "object") {
    return options.copilotSdkModule;
  }
  return import("@github/copilot-sdk");
}

async function withCopilotClient(options, fn) {
  const sdkModule = await getCopilotSdkModule(options);
  if (!sdkModule || typeof sdkModule.CopilotClient !== "function") {
    throw new Error("GitHub Copilot SDK client is unavailable");
  }
  const timeoutMs = resolvePositiveTimeoutMs(
    options.copilotResumeTimeoutMs ?? options.timeoutMs,
    DEFAULT_COPILOT_RESUME_TIMEOUT_MS,
  );
  const startedAtMs = Date.now();
  const client = new sdkModule.CopilotClient(await buildCopilotClientOptions(options));
  try {
    if (typeof client.start === "function") {
      const startTimeoutMs = remainingTimeoutMs(startedAtMs, timeoutMs, "copilot resume lookup timed out");
      await withTimeout(client.start(), startTimeoutMs, "copilot resume SDK start timed out");
    }
    const lookupTimeoutMs = remainingTimeoutMs(startedAtMs, timeoutMs, "copilot resume lookup timed out");
    return await withTimeout(fn(client), lookupTimeoutMs, "copilot resume lookup timed out");
  } finally {
    try {
      if (typeof client.stop === "function") {
        const stopTimeoutMs = resolvePositiveTimeoutMs(
          options.copilotResumeStopTimeoutMs,
          DEFAULT_COPILOT_RESUME_STOP_TIMEOUT_MS,
        );
        await withTimeout(client.stop(), stopTimeoutMs, "copilot resume SDK stop timed out");
      }
    } catch {
      try {
        await client.forceStop?.();
      } catch {
        // best effort
      }
    }
  }
}

async function buildCopilotClientOptions(options = {}) {
  const clientOptions = options.copilotClientOptions && typeof options.copilotClientOptions === "object"
    ? { ...options.copilotClientOptions }
    : {};
  const configFilePath = options.configFilePath || options.configFile;
  const allowCliList =
    options.allowCliList && typeof options.allowCliList === "object"
      ? options.allowCliList
      : loadAllowCliList(configFilePath);
  const configEnv = buildConfiguredEnvMap(configFilePath);
  const commandLine = resolveCopilotCommandLine({ ...options, allowCliList });
  const cliLaunch = resolveCopilotCliLaunch(commandLine, {
    ...process.env,
    ...configEnv,
    ...options.env,
  });
  if (
    cliLaunch &&
    clientOptions.cliPath === undefined &&
    clientOptions.cliArgs === undefined &&
    clientOptions.cliUrl === undefined
  ) {
    if (cliLaunch.cliPath !== undefined) {
      clientOptions.cliPath = cliLaunch.cliPath;
    }
    if (cliLaunch.cliArgs !== undefined) {
      clientOptions.cliArgs = cliLaunch.cliArgs;
    }
  }

  const explicitGithubToken =
    typeof clientOptions.gitHubToken === "string" && clientOptions.gitHubToken.trim()
      ? clientOptions.gitHubToken.trim()
      : typeof options.githubToken === "string" && options.githubToken.trim()
        ? options.githubToken.trim()
        : "";
  if (clientOptions.gitHubToken === undefined && explicitGithubToken) {
    clientOptions.gitHubToken = explicitGithubToken;
  }
  if (clientOptions.useLoggedInUser === undefined && typeof options.useLoggedInUser === "boolean") {
    clientOptions.useLoggedInUser = options.useLoggedInUser;
  }

  let resolvedEnv;
  if (clientOptions.env === undefined) {
    resolvedEnv = {
      ...process.env,
      ...configEnv,
      ...(options.env && typeof options.env === "object" ? options.env : {}),
      ...(hasOwnEnumerableKeys(cliLaunch?.env) ? cliLaunch.env : {}),
    };
  } else if (hasOwnEnumerableKeys(cliLaunch?.env)) {
    resolvedEnv = { ...clientOptions.env, ...cliLaunch.env };
  } else {
    resolvedEnv = { ...clientOptions.env };
  }
  clientOptions.env = explicitGithubToken
    ? resolvedEnv
    : withoutCopilotGithubTokenEnv(resolvedEnv);
  if (!explicitGithubToken && clientOptions.useLoggedInUser === undefined) {
    clientOptions.useLoggedInUser = true;
  }
  if (clientOptions.cwd === undefined) {
    const cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    clientOptions.cwd = cwd;
  }
  return clientOptions;
}

function resolveCopilotCommandLine(options = {}) {
  if (typeof options.commandLine === "string" && options.commandLine.trim()) {
    return options.commandLine.trim();
  }
  const allowCliList =
    options.allowCliList && typeof options.allowCliList === "object" ? options.allowCliList : {};
  const backendCandidates = [];
  const pushCandidate = (backend) => {
    const normalized = typeof backend === "string" ? backend.trim().toLowerCase() : "";
    if (normalized && !backendCandidates.includes(normalized)) {
      backendCandidates.push(normalized);
    }
  };
  pushCandidate(options.backend);
  pushCandidate(options.runtimeBackend);
  pushCandidate("copilot");
  for (const candidate of backendCandidates) {
    const entry = allowCliList[candidate];
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
  }
  return "";
}

function resolveCopilotCliLaunch(commandLine, env = process.env) {
  const normalized = typeof commandLine === "string" ? commandLine.trim() : "";
  if (!normalized) {
    return null;
  }
  const parsed = parseCommandParts(normalized);
  const unwrapped = unwrapEnvironmentCommand(parsed.command, parsed.args);
  const command = unwrapped.command;
  const args = unwrapped.args;
  if (!command) {
    return null;
  }
  const cliArgs = normalizeCopilotCliArgs(args);
  if (isDefaultCopilotCommand(command)) {
    if (cliArgs.length === 0 && !hasOwnEnumerableKeys(unwrapped.env)) {
      return null;
    }
    return { cliArgs, env: unwrapped.env };
  }
  const launchEnv = { ...process.env, ...env, ...unwrapped.env };
  const resolvedPath = resolveExecutablePath(command, launchEnv);
  return {
    cliPath: resolvedPath || command,
    cliArgs,
    env: unwrapped.env,
  };
}

function normalizeCopilotCliArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }
  return args.filter((item) => {
    const normalized = typeof item === "string" ? item.trim().toLowerCase() : "";
    return normalized && !LEGACY_COPILOT_CLI_ARGS.has(normalized);
  });
}

function stripExecutableSuffix(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\.(cmd|bat|exe)$/i, "");
}

function isDefaultCopilotCommand(command) {
  const normalized = String(command || "").trim();
  if (!normalized || /[\\/]/.test(normalized)) {
    return false;
  }
  return stripExecutableSuffix(normalized) === "copilot";
}

function isEnvironmentAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token || "").trim());
}

function parseEnvironmentAssignment(token) {
  const normalized = String(token || "");
  const index = normalized.indexOf("=");
  if (index <= 0) {
    return null;
  }
  return {
    key: normalized.slice(0, index),
    value: normalized.slice(index + 1),
  };
}

function isEnvCommand(command) {
  return stripExecutableSuffix(path.basename(String(command || ""))) === "env";
}

function isPathLikeCommand(command) {
  const normalized = String(command || "").trim();
  return (
    normalized.startsWith(".") ||
    normalized.startsWith("/") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(normalized)
  );
}

function resolveExecutablePath(command, env = process.env) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return "";
  }
  if (isPathLikeCommand(normalized)) {
    return normalized;
  }

  const pathEnv = typeof env?.PATH === "string" ? env.PATH : process.env.PATH || "";
  const pathExt =
    process.platform === "win32" && !path.extname(normalized)
      ? String(env?.PATHEXT || process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of pathExt) {
      const candidate = path.join(dir, `${normalized}${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "";
}

function unwrapEnvironmentCommand(command, args) {
  const parts = [command, ...args].filter((item) => typeof item === "string" && item.length > 0);
  const extraEnv = {};
  let index = 0;

  while (index < parts.length && isEnvironmentAssignment(parts[index])) {
    const assignment = parseEnvironmentAssignment(parts[index]);
    if (assignment) {
      extraEnv[assignment.key] = assignment.value;
    }
    index += 1;
  }

  if (index > 0) {
    return {
      command: parts[index] || "",
      args: parts.slice(index + 1),
      env: extraEnv,
    };
  }

  if (!isEnvCommand(command)) {
    return { command, args, env: extraEnv };
  }

  index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (isEnvironmentAssignment(token)) {
      const assignment = parseEnvironmentAssignment(token);
      if (assignment) {
        extraEnv[assignment.key] = assignment.value;
      }
      index += 1;
      continue;
    }
    if (String(token || "").startsWith("-")) {
      return { command, args, env: extraEnv };
    }
    break;
  }

  return {
    command: args[index] || "",
    args: args.slice(index + 1),
    env: extraEnv,
  };
}

function hasOwnEnumerableKeys(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function resolvePositiveTimeoutMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function remainingTimeoutMs(startedAtMs, timeoutMs, message) {
  const remaining = timeoutMs - (Date.now() - startedAtMs);
  if (remaining <= 0) {
    throw new Error(message);
  }
  return remaining;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildConfiguredEnvMap(configFilePath) {
  const envConfig = loadEnvConfig(configFilePath);
  if (!envConfig) {
    return {};
  }
  const normalizedEnv = { ...proxyToEnv(envConfig) };
  for (const [key, value] of Object.entries(envConfig)) {
    const normalized = typeof value === "string" && value.trim() ? value.trim() : undefined;
    if (normalized !== undefined) {
      normalizedEnv[key] = normalized;
    }
  }
  return normalizedEnv;
}

// Suppress unused-import lint for COPILOT_GITHUB_TOKEN_ENV_KEYS — retained for reference.
export const _COPILOT_GITHUB_TOKEN_ENV_KEYS = COPILOT_GITHUB_TOKEN_ENV_KEYS;
