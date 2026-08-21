import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { COPILOT_SDK_VARIANT as COPILOT_PROVIDER_VARIANT } from "../built-in-backends.js";
import { appendContextFilesToPrompt } from "../context-files.js";
import { PROVIDER_MEDIA_CAPABILITIES, buildCopilotAttachments } from "../media-adapters.js";
import {
  assertMediaCapabilities,
  defaultPromptForMedia,
  resolveTurnMedia,
} from "../media-input.js";
import {
  emitLog,
  getBoundedEnvInt,
  loadEnvConfig,
  normalizeLogger,
  parseCommandParts,
  proxyToEnv,
  sanitizeForLog,
  withoutCopilotGithubTokenEnv,
} from "../shared.js";

const DEFAULT_TURN_DEADLINE_MS = 12 * 60 * 1000;
const MIN_TURN_DEADLINE_MS = 30 * 1000;
const MAX_TURN_DEADLINE_MS = 30 * 60 * 1000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5 * 1000;
const SDK_SEND_AND_WAIT_TIMEOUT_GRACE_MS = 5 * 1000;
const LEGACY_COPILOT_CLI_ARGS = new Set(["--allow-all-paths", "--allow-all-tools"]);
const moduleRequire = createRequire(import.meta.url);

function waitForever() {
  return new Promise(() => {});
}

function createTurnError(message, extras = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(extras)) {
    error[key] = value;
  }
  return error;
}

function resolvePositiveTimeoutMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
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

function normalizeCopilotBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  return normalized || "copilot";
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function sanitizeSummary(value, maxLen = 180) {
  return sanitizeForLog(value, maxLen);
}

function normalizeReasoningEffort(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
    return normalized;
  }
  return undefined;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function isTruthyPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
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
      if (existsSync(candidate)) {
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

function resolveCopilotPlatformPackageName(platform = process.platform, arch = process.arch) {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    return null;
  }
  if (!["arm64", "x64"].includes(arch)) {
    return null;
  }
  return `@github/copilot-${platform}-${arch}`;
}

function resolvePackageFileFromSearchPaths(packageName, relativePath, resolvePackagePaths, existsSyncFn) {
  const searchPaths = resolvePackagePaths(packageName) || [];
  const packageParts = packageName.split("/");
  for (const basePath of searchPaths) {
    const candidate = path.join(basePath, ...packageParts, relativePath);
    if (existsSyncFn(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveBundledCopilotCliPath({
  platform = process.platform,
  arch = process.arch,
  resolvePackage = (packageName) => moduleRequire.resolve(packageName),
  resolvePackagePaths = (packageName) => moduleRequire.resolve.paths(packageName) || [],
  existsSyncFn = existsSync,
} = {}) {
  const platformPackageName = resolveCopilotPlatformPackageName(platform, arch);
  if (platformPackageName) {
    try {
      const platformExecutablePath = resolvePackage(platformPackageName);
      if (platformExecutablePath && existsSyncFn(platformExecutablePath)) {
        return platformExecutablePath;
      }
    } catch {
      // Optional platform packages may be absent when optional dependencies are disabled.
    }
  }

  return resolvePackageFileFromSearchPaths(
    "@github/copilot",
    "npm-loader.js",
    resolvePackagePaths,
    existsSyncFn,
  );
}

function hasExplicitCopilotCliPathEnv(env) {
  return typeof env?.COPILOT_CLI_PATH === "string" && env.COPILOT_CLI_PATH.trim();
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
    return {
      cliArgs,
      env: unwrapped.env,
    };
  }
  const launchEnv = {
    ...process.env,
    ...env,
    ...unwrapped.env,
  };
  const resolvedPath = resolveExecutablePath(command, launchEnv);
  return {
    cliPath: resolvedPath || command,
    cliArgs,
    env: unwrapped.env,
  };
}

function toolPhaseForName(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized) {
    return "tool_call";
  }
  if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("replace")
  ) {
    return "file_update";
  }
  if (
    normalized.includes("read") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("ls")
  ) {
    return "workspace_inspection";
  }
  if (normalized.includes("web") || normalized.includes("fetch") || normalized.includes("search")) {
    return "web_lookup";
  }
  if (normalized.includes("task") || normalized.includes("agent")) {
    return "task_progress";
  }
  return "tool_call";
}

function statusLineForPhase(phase, toolName = "", detail = "") {
  switch (phase) {
    case "reasoning":
      return "copilot reasoning";
    case "planning":
      return detail || "copilot updating plan";
    case "command_execution":
      return toolName ? `copilot running ${toolName}` : "copilot running command";
    case "file_update":
      return toolName ? `copilot editing with ${toolName}` : "copilot editing files";
    case "workspace_inspection":
      return toolName ? `copilot reading with ${toolName}` : "copilot reading workspace";
    case "web_lookup":
      return toolName ? `copilot browsing with ${toolName}` : "copilot browsing";
    case "task_progress":
      return detail || (toolName ? `copilot running ${toolName}` : "copilot running task");
    case "message_aggregation":
      return "copilot composing reply";
    case "tool_call":
      return detail || (toolName ? `copilot calling ${toolName}` : "copilot calling tool");
    default:
      return "copilot is working";
  }
}

function extractErrorMessage(error) {
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Copilot turn failed";
}

function normalizeTurnError(error) {
  if (error instanceof Error) {
    return error;
  }
  return createTurnError(extractErrorMessage(error));
}

function normalizeUsagePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return { ...payload };
}

function extractToolResultPreview(result) {
  if (!result || typeof result !== "object") {
    return "";
  }
  const contentBlocks = Array.isArray(result.contents) ? result.contents : [];
  const blockPreview = contentBlocks
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
  const fallbackPreview =
    (typeof result.detailedContent === "string" && result.detailedContent.trim()
      ? result.detailedContent
      : "") ||
    (typeof result.content === "string" && result.content.trim() ? result.content : "");
  return sanitizeSummary(blockPreview || fallbackPreview, 120);
}

function isAuthLikeError({ errorType = "", message = "", statusCode = undefined } = {}) {
  const normalizedType = String(errorType || "").trim().toLowerCase();
  const normalizedMessage = String(message || "").trim().toLowerCase();
  return (
    normalizedType.includes("auth") ||
    normalizedType.includes("login") ||
    normalizedType.includes("permission") ||
    normalizedMessage.includes("auth") ||
    normalizedMessage.includes("login") ||
    normalizedMessage.includes("sign in") ||
    normalizedMessage.includes("device code") ||
    normalizedMessage.includes("token") ||
    statusCode === 401 ||
    statusCode === 403
  );
}

function buildCopilotClientOptions(options, cwd, env) {
  const clientOptions = isTruthyPlainObject(options.copilotClientOptions) ? { ...options.copilotClientOptions } : {};

  const commandLine =
    typeof options.commandLine === "string" && options.commandLine.trim()
      ? options.commandLine.trim()
      : "";
  const cliLaunch = resolveCopilotCliLaunch(commandLine, env);
  if (cliLaunch && clientOptions.cliPath === undefined && clientOptions.cliArgs === undefined && clientOptions.cliUrl === undefined) {
    if (cliLaunch.cliPath !== undefined) {
      clientOptions.cliPath = cliLaunch.cliPath;
    }
    if (cliLaunch.cliArgs !== undefined) {
      clientOptions.cliArgs = cliLaunch.cliArgs;
    }
  }

  const passthroughKeys = [
    "cliPath",
    "cliArgs",
    "cliUrl",
    "port",
    "useStdio",
    "isChildProcess",
    "logLevel",
    "autoStart",
    "autoRestart",
    "onListModels",
    "telemetry",
    "onGetTraceContext",
  ];
  for (const key of passthroughKeys) {
    if (clientOptions[key] !== undefined || options[key] === undefined) {
      continue;
    }
    clientOptions[key] = key === "cliArgs" ? normalizeCopilotCliArgs(options[key]) : options[key];
  }

  const explicitGithubToken =
    typeof options.githubToken === "string" && options.githubToken.trim()
      ? options.githubToken.trim()
      : "";
  if (clientOptions.gitHubToken === undefined && explicitGithubToken) {
    clientOptions.gitHubToken = explicitGithubToken;
  }
  const hasExplicitGithubToken =
    typeof clientOptions.gitHubToken === "string" && clientOptions.gitHubToken.trim();
  if (clientOptions.useLoggedInUser === undefined && typeof options.useLoggedInUser === "boolean") {
    clientOptions.useLoggedInUser = options.useLoggedInUser;
  }
  if (clientOptions.cwd === undefined) {
    clientOptions.cwd = cwd;
  }
  let resolvedEnv;
  if (clientOptions.env === undefined) {
    resolvedEnv = {
      ...process.env,
      ...env,
      ...(hasOwnEnumerableKeys(cliLaunch?.env) ? cliLaunch.env : {}),
    };
  } else if (hasOwnEnumerableKeys(cliLaunch?.env)) {
    resolvedEnv = {
      ...clientOptions.env,
      ...cliLaunch.env,
    };
  } else {
    resolvedEnv = { ...clientOptions.env };
  }
  clientOptions.env = hasExplicitGithubToken
    ? resolvedEnv
    : withoutCopilotGithubTokenEnv(resolvedEnv);
  if (
    clientOptions.cliPath === undefined &&
    clientOptions.cliUrl === undefined &&
    !hasExplicitCopilotCliPathEnv(clientOptions.env)
  ) {
    const bundledCliPath = resolveBundledCopilotCliPath();
    if (bundledCliPath) {
      clientOptions.cliPath = bundledCliPath;
    }
  }
  if (!hasExplicitGithubToken && clientOptions.useLoggedInUser === undefined) {
    clientOptions.useLoggedInUser = true;
  }

  return clientOptions;
}

function buildCopilotSessionConfig(options, cwd, permissionHandler) {
  const sessionConfig = isTruthyPlainObject(options.copilotSessionConfig) ? { ...options.copilotSessionConfig } : {};
  const passthroughKeys = [
    "clientName",
    "tools",
    "commands",
    "systemMessage",
    "provider",
    "modelCapabilities",
    "onUserInputRequest",
    "onElicitationRequest",
    "hooks",
    "configDir",
    "enableConfigDiscovery",
    "mcpServers",
    "customAgents",
    "agent",
    "skillDirectories",
    "disabledSkills",
    "infiniteSessions",
    "createSessionFsHandler",
  ];
  for (const key of passthroughKeys) {
    if (sessionConfig[key] !== undefined || options[key] === undefined) {
      continue;
    }
    sessionConfig[key] = options[key];
  }

  const availableTools = normalizeStringList(options.availableTools);
  if (sessionConfig.availableTools === undefined && availableTools) {
    sessionConfig.availableTools = availableTools;
  }
  const excludedTools = normalizeStringList(options.excludedTools);
  if (sessionConfig.excludedTools === undefined && excludedTools) {
    sessionConfig.excludedTools = excludedTools;
  }

  if (sessionConfig.model === undefined && typeof options.model === "string" && options.model.trim()) {
    sessionConfig.model = options.model.trim();
  }

  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  if (sessionConfig.reasoningEffort === undefined && reasoningEffort) {
    sessionConfig.reasoningEffort = reasoningEffort;
  }

  if (sessionConfig.streaming === undefined) {
    sessionConfig.streaming = true;
  }
  if (sessionConfig.workingDirectory === undefined) {
    sessionConfig.workingDirectory = cwd;
  }
  if (sessionConfig.onPermissionRequest === undefined) {
    sessionConfig.onPermissionRequest = permissionHandler;
  }

  return sessionConfig;
}

export class CopilotSdkSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = normalizeCopilotBackend(backend);
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    this.resumeSessionId = typeof options.resumeSessionId === "string" ? options.resumeSessionId.trim() : "";
    this.sessionId = this.resumeSessionId || "";
    this.sessionInfo = this.sessionId
      ? {
          backend: this.backend,
          sessionId: this.sessionId,
          model:
            typeof options.model === "string" && options.model.trim()
              ? options.model.trim()
              : undefined,
          modelProvider: "github-copilot",
          reasoningEffort: normalizeReasoningEffort(options.reasoningEffort),
        }
      : null;
    this.history = Array.isArray(options.initialHistory) ? [...options.initialHistory] : [];
    this.pendingHistorySeed = this.history.length > 0;
    this.closeRequested = false;
    this.closed = false;
    this.closeWaiters = new Set();
    this.sessionMessageHandler = null;
    this.workingStatusHandler = null;
    this.activeReplyTarget = "";
    this.lastReplyTarget = "";
    this.currentTurn = null;
    this.lastUsage = null;
    this.currentTurnStatus = null;
    this.currentTurnActivityAt = 0;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.closeTimeoutMs = resolvePositiveTimeoutMs(options.copilotCloseTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    this.turnDeadlineMs = getBoundedEnvInt(
      "CONDUCTOR_TURN_DEADLINE_MS",
      DEFAULT_TURN_DEADLINE_MS,
      MIN_TURN_DEADLINE_MS,
      MAX_TURN_DEADLINE_MS,
    );
    this.client = null;
    this.session = null;
    this.booted = false;
    this.bootPromise = null;
    this.sdkModulePromise = null;
    this.sessionSubscriptions = [];
    this.lastAuthRequiredSignature = "";

    const envConfig = loadEnvConfig(options.configFile);
    const proxyEnv = proxyToEnv(envConfig);
    const extraEnv = envConfig && typeof envConfig === "object" ? { ...envConfig, ...proxyEnv } : proxyEnv;
    this.env = {
      ...extraEnv,
      ...(options.env && typeof options.env === "object" ? options.env : {}),
    };
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [copilot-sdk] ${message}`);
  }

  get threadId() {
    return this.sessionId;
  }

  get threadOptions() {
    const model =
      this.sessionInfo?.model ||
      (typeof this.options.model === "string" && this.options.model.trim()
        ? this.options.model.trim()
        : this.backend);
    return {
      model,
      modelProvider: this.sessionInfo?.modelProvider || undefined,
    };
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: COPILOT_PROVIDER_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId || undefined,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: Boolean(this.sessionId),
      manualResume: this.sessionId
        ? {
            ready: true,
            command: `copilot --resume=${this.sessionId}`,
          }
        : null,
      currentTurnStatus: this.getCurrentTurnStatus(),
      capabilities: { media: PROVIDER_MEDIA_CAPABILITIES[COPILOT_PROVIDER_VARIANT] },
    };
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  getCurrentTurnStatus() {
    return this.currentTurnStatus ? { ...this.currentTurnStatus } : null;
  }

  async ensureSessionInfo() {
    await this.boot();
    return this.getSessionInfo();
  }

  async getSessionUsageSummary() {
    return {
      sessionId: this.sessionId || undefined,
      sessionFilePath: undefined,
      totalCostUsd: undefined,
      usage: this.lastUsage ? { ...this.lastUsage } : null,
      rateLimits: this.lastUsage?.quotaSnapshots ? { ...this.lastUsage.quotaSnapshots } : null,
      manualResume: this.sessionId
        ? {
            ready: true,
            command: `copilot --resume=${this.sessionId}`,
          }
        : null,
    };
  }

  usesSessionFileReplyStream() {
    return true;
  }

  setSessionMessageHandler(handler) {
    this.sessionMessageHandler = typeof handler === "function" ? handler : null;
  }

  setWorkingStatusHandler(handler) {
    this.workingStatusHandler = typeof handler === "function" ? handler : null;
  }

  setSessionReplyTarget(replyTo) {
    const normalizedReplyTo = typeof replyTo === "string" ? replyTo.trim() : "";
    this.activeReplyTarget = normalizedReplyTo;
    if (normalizedReplyTo) {
      this.lastReplyTarget = normalizedReplyTo;
    }
  }

  getCurrentReplyTarget() {
    return this.activeReplyTarget || this.lastReplyTarget || undefined;
  }

  touchTurnActivity() {
    this.currentTurnActivityAt = this.now();
  }

  updateCurrentTurnStatus(payload) {
    const updatedAtMs = this.now();
    this.currentTurnActivityAt = updatedAtMs;
    this.currentTurnStatus = {
      ...payload,
      updated_at: new Date(updatedAtMs).toISOString(),
    };
  }

  markTurnStartedStatus() {
    this.updateCurrentTurnStatus({
      source: COPILOT_PROVIDER_VARIANT,
      reply_in_progress: true,
      replyTo: this.getCurrentReplyTarget(),
      phase: "turn_started",
      status_line: "copilot is working",
      thread_id: this.sessionId || undefined,
      session_id: this.sessionId || undefined,
      session_file_path: undefined,
    });
  }

  async emitWorkingStatus(payload, onProgress = null) {
    const normalized = {
      source: COPILOT_PROVIDER_VARIANT,
      reply_in_progress: Boolean(payload?.reply_in_progress),
      replyTo: payload?.replyTo || this.getCurrentReplyTarget(),
      state: payload?.state,
      phase: payload?.phase,
      status_line: payload?.status_line,
      status_done_line: payload?.status_done_line,
      reply_preview: payload?.reply_preview,
      thread_id: this.sessionId || undefined,
      session_id: this.sessionId || undefined,
      session_file_path: undefined,
    };
    this.updateCurrentTurnStatus(normalized);
    const snapshot = this.getCurrentTurnStatus();
    if (typeof onProgress === "function") {
      onProgress(snapshot);
    }
    if (typeof this.workingStatusHandler === "function") {
      await this.workingStatusHandler(snapshot);
    }
    this.emit("working_status", snapshot);
  }

  async emitAssistantMessage(text) {
    this.touchTurnActivity();
    const payload = {
      text,
      preserveWhitespace: true,
      source: COPILOT_PROVIDER_VARIANT,
      replyTo: this.getCurrentReplyTarget(),
      sessionId: this.sessionId || undefined,
      sessionFilePath: undefined,
      timestamp: new Date().toISOString(),
    };
    if (typeof this.sessionMessageHandler === "function") {
      await this.sessionMessageHandler(payload);
    }
    this.emit("assistant_message", payload);
  }

  async emitBufferedAssistantMessage(currentTurn, messageId) {
    if (!currentTurn || !messageId || currentTurn.emittedMessageIds.has(messageId)) {
      return false;
    }
    const text = currentTurn.messageText.get(messageId) || "";
    if (!text) {
      return false;
    }
    currentTurn.emittedMessageIds.add(messageId);
    await this.emitAssistantMessage(text);
    return true;
  }

  async emitPendingAssistantMessages(currentTurn) {
    let emitted = false;
    for (const messageId of currentTurn.messageOrder) {
      emitted = (await this.emitBufferedAssistantMessage(currentTurn, messageId)) || emitted;
    }
    return emitted;
  }

  async emitTerminalWorkingStatus(currentTurn, payload, onProgress = null) {
    if (!currentTurn || currentTurn.terminalWorkingStatusEmitted) {
      return;
    }
    currentTurn.terminalWorkingStatusEmitted = true;
    await this.emitWorkingStatus(
      {
        ...payload,
        reply_in_progress: false,
      },
      onProgress,
    );
  }

  createSessionClosedError() {
    const error = new Error("Copilot SDK session closed");
    error.reason = "session_closed";
    return error;
  }

  createTurnTimeoutError(timeoutMs) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const error = new Error(`Turn exceeded hard deadline (${seconds}s)`);
    error.reason = "turn_timeout";
    error.timeoutMs = timeoutMs;
    return error;
  }

  createTurnAlreadyRunningError() {
    const error = new Error("Copilot turn already in progress");
    error.reason = "turn_already_running";
    return error;
  }

  createCloseGuard(onClose) {
    if (this.closeRequested) {
      return {
        promise: Promise.reject(this.createSessionClosedError()),
        cleanup: () => {},
      };
    }
    let waiter = null;
    const promise = new Promise((_, reject) => {
      waiter = () => {
        try {
          onClose?.();
        } catch {
          // best effort
        }
        reject(this.createSessionClosedError());
      };
      this.closeWaiters.add(waiter);
    });
    return {
      promise,
      cleanup: () => {
        if (waiter) {
          this.closeWaiters.delete(waiter);
        }
      },
    };
  }

  createTurnTimeoutGuard(onTimeout) {
    if (!Number.isFinite(this.turnDeadlineMs) || this.turnDeadlineMs <= 0) {
      return {
        promise: waitForever(),
        cleanup: () => {},
      };
    }
    let timer = null;
    let settled = false;
    const schedule = (reject) => {
      const now = this.now();
      const lastActivityAt =
        Number.isFinite(this.currentTurnActivityAt) && this.currentTurnActivityAt > 0
          ? this.currentTurnActivityAt
          : now;
      const elapsedMs = Math.max(0, now - lastActivityAt);
      const waitMs = Math.max(1, this.turnDeadlineMs - elapsedMs);
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        const activityNow = this.now();
        const latestActivityAt =
          Number.isFinite(this.currentTurnActivityAt) && this.currentTurnActivityAt > 0
            ? this.currentTurnActivityAt
            : activityNow;
        if (activityNow - latestActivityAt < this.turnDeadlineMs) {
          schedule(reject);
          return;
        }
        settled = true;
        try {
          onTimeout?.();
        } catch {
          // best effort
        }
        reject(this.createTurnTimeoutError(this.turnDeadlineMs));
      }, waitMs);
      if (typeof timer?.unref === "function") {
        timer.unref();
      }
    };
    const promise = new Promise((_, reject) => {
      schedule(reject);
    });
    return {
      promise,
      cleanup: () => {
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
  }

  flushCloseWaiters() {
    if (this.closeWaiters.size === 0) {
      return;
    }
    for (const waiter of this.closeWaiters) {
      try {
        waiter();
      } catch {
        // best effort
      }
    }
    this.closeWaiters.clear();
  }

  buildPrompt(promptText, { useInitialImages = false } = {}) {
    let effectivePrompt = String(promptText || "").trim();
    if (!effectivePrompt) {
      return "";
    }

    if (this.pendingHistorySeed) {
      const historyText = this.history
        .map((item) => {
          const role = String(item?.role || "").toLowerCase() === "assistant" ? "Assistant" : "User";
          return `${role}: ${String(item?.content || "").trim()}`;
        })
        .filter(Boolean)
        .join("\n\n");
      if (historyText) {
        effectivePrompt = [
          "Continue the existing conversation with this history.",
          "",
          historyText,
          "",
          `User: ${effectivePrompt}`,
        ].join("\n");
      }
      this.pendingHistorySeed = false;
    }

    const images = Array.isArray(this.options.initialImages) ? this.options.initialImages : [];
    if (useInitialImages && images.length > 0) {
      const imageContext = images.map((item, idx) => `${idx + 1}. ${item}`).join("\n");
      effectivePrompt = `${effectivePrompt}\n\nAttached image files:\n${imageContext}`;
    }

    return effectivePrompt;
  }

  async getSdkModule() {
    if (this.sdkModulePromise) {
      return this.sdkModulePromise;
    }
    if (this.options.sdkModule && typeof this.options.sdkModule === "object") {
      this.sdkModulePromise = Promise.resolve(this.options.sdkModule);
      return this.sdkModulePromise;
    }
    this.sdkModulePromise = import("@github/copilot-sdk");
    return this.sdkModulePromise;
  }

  async boot() {
    if (this.booted) {
      return;
    }
    if (this.bootPromise) {
      return this.bootPromise;
    }
    this.bootPromise = this.bootInternal();
    try {
      await this.bootPromise;
      this.booted = true;
    } finally {
      this.bootPromise = null;
    }
  }

  async bootInternal() {
    const sdkModule = await this.getSdkModule();
    if (!sdkModule || typeof sdkModule.CopilotClient !== "function") {
      throw new Error("GitHub Copilot SDK client is unavailable");
    }

    const permissionHandler =
      typeof sdkModule.approveAll === "function"
        ? sdkModule.approveAll
        : () => ({ kind: "approve-once" });
    const clientOptions = buildCopilotClientOptions(this.options, this.cwd, this.env);
    this.client = new sdkModule.CopilotClient(clientOptions);
    const cleanupIfClosedDuringBoot = async (session = null) => {
      if (!this.closeRequested) {
        return;
      }
      try {
        await this.closeCopilotResources(session, this.client);
      } finally {
        if (this.session === session) {
          this.session = null;
        }
        this.client = null;
      }
      throw this.createSessionClosedError();
    };

    await cleanupIfClosedDuringBoot();
    if (typeof this.client.start === "function") {
      await this.client.start();
    }
    await cleanupIfClosedDuringBoot();

    const sessionConfig = buildCopilotSessionConfig(this.options, this.cwd, permissionHandler);
    this.session = this.resumeSessionId
      ? await this.requestOrThrow(this.client.resumeSession(this.resumeSessionId, sessionConfig))
      : await this.requestOrThrow(this.client.createSession(sessionConfig));
    await cleanupIfClosedDuringBoot(this.session);
    this.attachSessionEventHandlers(this.session);
    this.applySessionInfo(this.session?.sessionId, {
      model:
        typeof sessionConfig.model === "string" && sessionConfig.model.trim()
          ? sessionConfig.model.trim()
          : undefined,
      reasoningEffort:
        typeof sessionConfig.reasoningEffort === "string" && sessionConfig.reasoningEffort.trim()
          ? sessionConfig.reasoningEffort.trim()
          : undefined,
    });
  }

  attachSessionEventHandlers(session) {
    if (!session || typeof session.on !== "function") {
      return;
    }
    const eventTypes = [
      "session.error",
      "session.idle",
      "assistant.turn_start",
      "assistant.intent",
      "assistant.reasoning",
      "assistant.reasoning_delta",
      "assistant.message",
      "assistant.message_delta",
      "assistant.turn_end",
      "assistant.usage",
      "tool.execution_start",
      "tool.execution_progress",
      "tool.execution_partial_result",
      "tool.execution_complete",
      "abort",
    ];
    for (const eventType of eventTypes) {
      const unsubscribe = session.on(eventType, (event) => {
        void this.handleCopilotEvent(event).catch((error) => {
          this.handleCopilotEventFailure(error);
        });
      });
      if (typeof unsubscribe === "function") {
        this.sessionSubscriptions.push(unsubscribe);
      }
    }
  }

  detachSessionEventHandlers() {
    if (this.sessionSubscriptions.length === 0) {
      return;
    }
    for (const unsubscribe of this.sessionSubscriptions) {
      try {
        unsubscribe();
      } catch {
        // best effort
      }
    }
    this.sessionSubscriptions = [];
  }

  async requestOrThrow(promise) {
    try {
      return await promise;
    } catch (error) {
      this.maybeEmitAuthRequired({
        message: extractErrorMessage(error),
      });
      throw error;
    }
  }

  applySessionInfo(sessionId, extras = {}) {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) {
      return;
    }
    const changed = this.sessionId !== normalizedSessionId;
    this.sessionId = normalizedSessionId;
    const resolvedReasoningEffort =
      typeof extras.reasoningEffort === "string" && extras.reasoningEffort.trim()
        ? extras.reasoningEffort.trim()
        : typeof this.lastUsage?.reasoningEffort === "string" && this.lastUsage.reasoningEffort.trim()
          ? this.lastUsage.reasoningEffort.trim()
          : normalizeReasoningEffort(this.options.reasoningEffort);
    const resolvedModel =
      typeof extras.model === "string" && extras.model.trim()
        ? extras.model.trim()
        : typeof this.lastUsage?.model === "string" && this.lastUsage.model.trim()
          ? this.lastUsage.model.trim()
          : typeof this.options.model === "string" && this.options.model.trim()
            ? this.options.model.trim()
            : undefined;
    this.sessionInfo = {
      ...(this.sessionInfo || {}),
      backend: this.backend,
      sessionId: normalizedSessionId,
      model: resolvedModel,
      modelProvider: "github-copilot",
      reasoningEffort: resolvedReasoningEffort,
    };
    if (changed) {
      this.trace(`session ready id=${normalizedSessionId}`);
      this.emit("session", this.getSessionInfo());
    }
  }

  maybeEmitAuthRequired({ errorType = "", message = "", statusCode = undefined, url = undefined } = {}) {
    if (!isAuthLikeError({ errorType, message, statusCode })) {
      return;
    }
    const signature = `${String(errorType)}\n${String(statusCode ?? "")}\n${String(message)}\n${String(url || "")}`;
    if (signature === this.lastAuthRequiredSignature) {
      return;
    }
    this.lastAuthRequiredSignature = signature;
    this.emit("auth_required", {
      reason: "login_required",
      message: message || "GitHub Copilot authentication is required",
      url: typeof url === "string" && url.trim() ? url.trim() : undefined,
    });
  }

  createMessageId(currentTurn, messageId) {
    const normalizedMessageId =
      typeof messageId === "string" && messageId.trim()
        ? messageId.trim()
        : `message-${currentTurn.messageOrder.length + 1}`;
    if (!currentTurn.messageOrder.includes(normalizedMessageId)) {
      currentTurn.messageOrder.push(normalizedMessageId);
    }
    if (!currentTurn.messageText.has(normalizedMessageId)) {
      currentTurn.messageText.set(normalizedMessageId, "");
    }
    return normalizedMessageId;
  }

  updateMessageText(currentTurn, messageId, text, { replace = false } = {}) {
    const normalizedMessageId = this.createMessageId(currentTurn, messageId);
    const existingText = currentTurn.messageText.get(normalizedMessageId) || "";
    const nextText = replace ? normalizeText(text) : `${existingText}${normalizeText(text)}`;
    currentTurn.messageText.set(normalizedMessageId, nextText);
    currentTurn.fullText = currentTurn.messageOrder
      .map((id) => currentTurn.messageText.get(id) || "")
      .join("");
    return {
      messageId: normalizedMessageId,
      fullText: currentTurn.fullText,
      messageText: nextText,
    };
  }

  applyCompletionText(currentTurn, completion) {
    const completionText =
      normalizeText(completion?.data?.content) ||
      normalizeText(completion?.content);
    if (!completionText) {
      return "";
    }
    const completionMessageId =
      typeof completion?.data?.messageId === "string" && completion.data.messageId.trim()
        ? completion.data.messageId.trim()
        : typeof completion?.messageId === "string" && completion.messageId.trim()
          ? completion.messageId.trim()
          : "";
    if (completionMessageId) {
      return this.updateMessageText(currentTurn, completionMessageId, completionText, { replace: true }).fullText;
    }
    if (currentTurn.messageOrder.length === 1) {
      return this.updateMessageText(currentTurn, currentTurn.messageOrder[0], completionText, { replace: true }).fullText;
    }
    if (currentTurn.messageOrder.length === 0) {
      return this.updateMessageText(currentTurn, undefined, completionText, { replace: true }).fullText;
    }
    return currentTurn.fullText || completionText;
  }

  async closeCopilotResources(session, client) {
    let forceStopAttempted = false;
    const forceStopClient = async () => {
      if (forceStopAttempted || !client || typeof client.forceStop !== "function") {
        return;
      }
      forceStopAttempted = true;
      try {
        await client.forceStop();
      } catch {
        // best effort
      }
    };

    try {
      if (session && typeof session.disconnect === "function") {
        await withTimeout(session.disconnect(), this.closeTimeoutMs, "copilot session disconnect timed out");
      }
    } catch {
      await forceStopClient();
    }

    if (forceStopAttempted) {
      return;
    }

    try {
      if (client && typeof client.stop === "function") {
        await withTimeout(client.stop(), this.closeTimeoutMs, "copilot SDK stop timed out");
      }
    } catch {
      await forceStopClient();
    }
  }

  setCurrentTurnError(currentTurn, error) {
    if (!currentTurn || currentTurn.error) {
      return;
    }
    currentTurn.error = normalizeTurnError(error);
  }

  handleCopilotEventFailure(error) {
    this.setCurrentTurnError(this.currentTurn, error);
    this.trace(`event handling failed: ${extractErrorMessage(error)}`);
    void this.interruptCurrentTurn().catch(() => {});
  }

  async handleCopilotEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }

    this.touchTurnActivity();
    const currentTurn = this.currentTurn;
    if (currentTurn) {
      currentTurn.items.push(event);
      currentTurn.events.push(event);
    }

    switch (event.type) {
      case "assistant.turn_start": {
        if (!currentTurn) {
          return;
        }
        await this.emitWorkingStatus(
          {
            phase: "turn_started",
            reply_in_progress: true,
            status_line: "copilot is working",
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "assistant.intent": {
        if (!currentTurn) {
          return;
        }
        const intent = sanitizeSummary(event.data?.intent);
        await this.emitWorkingStatus(
          {
            phase: "planning",
            reply_in_progress: true,
            status_line: statusLineForPhase("planning", "", intent),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "assistant.reasoning":
      case "assistant.reasoning_delta": {
        if (!currentTurn) {
          return;
        }
        await this.emitWorkingStatus(
          {
            phase: "reasoning",
            reply_in_progress: true,
            status_line: statusLineForPhase("reasoning"),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "tool.execution_start": {
        if (!currentTurn) {
          return;
        }
        currentTurn.activeToolName = normalizeText(event.data?.toolName);
        currentTurn.activeToolPhase = toolPhaseForName(currentTurn.activeToolName);
        await this.emitWorkingStatus(
          {
            phase: currentTurn.activeToolPhase,
            reply_in_progress: true,
            status_line: statusLineForPhase(currentTurn.activeToolPhase, currentTurn.activeToolName),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "tool.execution_progress": {
        if (!currentTurn) {
          return;
        }
        const progressMessage = sanitizeSummary(event.data?.progressMessage);
        const phase = currentTurn.activeToolPhase || "tool_call";
        await this.emitWorkingStatus(
          {
            phase,
            reply_in_progress: true,
            status_line: progressMessage || statusLineForPhase(phase, currentTurn.activeToolName),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "tool.execution_partial_result": {
        if (!currentTurn) {
          return;
        }
        const partialOutput = sanitizeSummary(event.data?.partialOutput, 120);
        const phase = currentTurn.activeToolPhase || "tool_call";
        await this.emitWorkingStatus(
          {
            phase,
            reply_in_progress: true,
            status_line: statusLineForPhase(phase, currentTurn.activeToolName),
            reply_preview: partialOutput || undefined,
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "tool.execution_complete": {
        if (!currentTurn) {
          return;
        }
        currentTurn.activeToolName = "";
        currentTurn.activeToolPhase = "";
        const preview = extractToolResultPreview(event.data?.result);
        await this.emitWorkingStatus(
          {
            phase: "message_aggregation",
            reply_in_progress: true,
            status_line: statusLineForPhase("message_aggregation"),
            reply_preview: preview || undefined,
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "assistant.message_delta": {
        if (!currentTurn) {
          return;
        }
        const deltaContent = normalizeText(event.data?.deltaContent);
        if (!deltaContent) {
          return;
        }
        const normalizedMessageId = this.createMessageId(currentTurn, event.data?.messageId);
        const { fullText } = this.updateMessageText(currentTurn, normalizedMessageId, deltaContent);
        await this.emitWorkingStatus(
          {
            phase: "message_aggregation",
            reply_in_progress: true,
            status_line: statusLineForPhase("message_aggregation"),
            reply_preview: sanitizeSummary(fullText, 120),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "assistant.message": {
        if (!currentTurn) {
          return;
        }
        const content = normalizeText(event.data?.content);
        if (!content) {
          return;
        }
        const normalizedMessageId = this.createMessageId(currentTurn, event.data?.messageId);
        const { fullText } = this.updateMessageText(currentTurn, normalizedMessageId, content, {
          replace: true,
        });
        await this.emitWorkingStatus(
          {
            phase: "message_aggregation",
            reply_in_progress: true,
            status_line: statusLineForPhase("message_aggregation"),
            reply_preview: sanitizeSummary(fullText, 120),
          },
          currentTurn.onProgress,
        );
        await this.emitBufferedAssistantMessage(currentTurn, normalizedMessageId);
        return;
      }
      case "assistant.usage": {
        this.lastUsage = normalizeUsagePayload(event.data);
        this.applySessionInfo(this.sessionId || this.resumeSessionId, {
          model:
            typeof event.data?.model === "string" && event.data.model.trim()
              ? event.data.model.trim()
              : undefined,
          reasoningEffort:
            typeof event.data?.reasoningEffort === "string" && event.data.reasoningEffort.trim()
              ? event.data.reasoningEffort.trim()
              : undefined,
        });
        return;
      }
      case "assistant.turn_end": {
        if (!currentTurn) {
          return;
        }
        await this.emitWorkingStatus(
          {
            phase: "message_aggregation",
            reply_in_progress: true,
            status_line: statusLineForPhase("message_aggregation"),
            reply_preview: sanitizeSummary(currentTurn.fullText, 120),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "session.error": {
        const message = normalizeText(event.data?.message) || "Copilot turn failed";
        this.maybeEmitAuthRequired({
          errorType: event.data?.errorType,
          message,
          statusCode: event.data?.statusCode,
          url: event.data?.url,
        });
        if (!currentTurn) {
          return;
        }
        currentTurn.error = createTurnError(message, {
          reason: "provider_error",
          errorType: event.data?.errorType,
          statusCode: event.data?.statusCode,
          url: event.data?.url,
        });
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_failed",
            status_done_line: message,
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "abort": {
        if (!currentTurn) {
          return;
        }
        currentTurn.abortRequested = true;
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_interrupted",
            status_done_line: normalizeText(event.data?.reason) || "copilot interrupted",
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "session.idle": {
        if (!currentTurn) {
          return;
        }
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: currentTurn.abortRequested || event.data?.aborted ? "turn_interrupted" : "turn_completed",
            status_done_line:
              currentTurn.abortRequested || event.data?.aborted ? "copilot interrupted" : "copilot finished",
          },
          currentTurn.onProgress,
        );
        return;
      }
      default:
        return;
    }
  }

  async interruptCurrentTurn() {
    if (!this.currentTurn || !this.session || typeof this.session.abort !== "function") {
      return;
    }
    try {
      await this.session.abort();
    } catch (error) {
      if (!this.closeRequested) {
        throw error;
      }
    }
  }

  async runTurn(promptText, { useInitialImages = false, media: mediaInput, contextFiles, onProgress = null } = {}) {
    if (this.currentTurn) {
      throw this.createTurnAlreadyRunningError();
    }
    const media = resolveTurnMedia(this.options, { useInitialImages, media: mediaInput });
    assertMediaCapabilities(media, this.backend, PROVIDER_MEDIA_CAPABILITIES[COPILOT_PROVIDER_VARIANT]);
    const prompt = appendContextFilesToPrompt(
      this.buildPrompt(promptText, { useInitialImages: false }) || (media.length ? defaultPromptForMedia(media) : ""),
      contextFiles,
    ).prompt;
    if (!prompt && media.length === 0) {
      return {
        text: "",
        usage: this.lastUsage ? { ...this.lastUsage } : null,
        items: [],
        events: [],
        provider: this.backend,
        metadata: {
          source: COPILOT_PROVIDER_VARIANT,
          sessionId: this.sessionId || undefined,
        },
      };
    }

    const currentTurn = {
      items: [],
      events: [],
      fullText: "",
      messageOrder: [],
      messageText: new Map(),
      emittedMessageIds: new Set(),
      activeToolName: "",
      activeToolPhase: "",
      abortRequested: false,
      terminalWorkingStatusEmitted: false,
      error: null,
      onProgress,
    };
    this.currentTurn = currentTurn;
    this.touchTurnActivity();
    this.markTurnStartedStatus();

    const closeGuard = this.createCloseGuard(() => {
      void this.interruptCurrentTurn();
    });
    const turnTimeoutGuard = this.createTurnTimeoutGuard(() => {
      void this.interruptCurrentTurn();
    });

    try {
      await Promise.race([
        this.boot(),
        closeGuard.promise,
        turnTimeoutGuard.promise,
      ]);
      this.applySessionInfo(this.session?.sessionId || this.sessionId);

      const completion = await Promise.race([
        this.requestOrThrow(
          this.session.sendAndWait(
            {
              prompt,
              attachments: buildCopilotAttachments(media),
              mode: "immediate",
            },
            this.turnDeadlineMs + SDK_SEND_AND_WAIT_TIMEOUT_GRACE_MS,
          ),
        ),
        closeGuard.promise,
        turnTimeoutGuard.promise,
      ]);

      if (currentTurn.error) {
        throw currentTurn.error;
      }

      const completionText =
        this.applyCompletionText(currentTurn, completion) ||
        currentTurn.fullText;
      if (completionText && !currentTurn.fullText) {
        currentTurn.fullText = completionText;
      }
      const emittedBufferedMessages = await this.emitPendingAssistantMessages(currentTurn);
      if (completionText && currentTurn.messageOrder.length === 0 && !emittedBufferedMessages) {
        await this.emitWorkingStatus(
          {
            phase: "message_aggregation",
            reply_in_progress: true,
            status_line: statusLineForPhase("message_aggregation"),
            reply_preview: sanitizeSummary(completionText, 120),
          },
          onProgress,
        );
        await this.emitAssistantMessage(completionText);
      }
      if (completionText) {
        this.history.push({ role: "assistant", content: completionText });
      }

      this.activeReplyTarget = "";

      await this.emitTerminalWorkingStatus(
        currentTurn,
        {
          phase: currentTurn.abortRequested ? "turn_interrupted" : "turn_completed",
          status_done_line: currentTurn.abortRequested ? "copilot interrupted" : "copilot finished",
        },
        onProgress,
      );

      return {
        text: completionText,
        usage: this.lastUsage ? { ...this.lastUsage } : null,
        items: currentTurn.items,
        events: currentTurn.events,
        provider: this.backend,
        metadata: {
          source: COPILOT_PROVIDER_VARIANT,
          sessionId: this.sessionId || undefined,
          model: this.sessionInfo?.model,
          modelProvider: this.sessionInfo?.modelProvider,
          reasoningEffort: this.sessionInfo?.reasoningEffort,
        },
      };
    } catch (error) {
      if (error?.reason === "turn_timeout") {
        await this.interruptCurrentTurn();
      }
      const message = extractErrorMessage(currentTurn.error || error);
      await this.emitTerminalWorkingStatus(
        currentTurn,
        {
          phase: error?.reason === "turn_interrupted" || currentTurn.abortRequested ? "turn_interrupted" : "turn_failed",
          status_done_line: message,
        },
        onProgress,
      );
      throw currentTurn.error || error;
    } finally {
      closeGuard.cleanup();
      turnTimeoutGuard.cleanup();
      this.activeReplyTarget = "";
      this.currentTurn = null;
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeRequested = true;
    this.flushCloseWaiters();

    try {
      await this.interruptCurrentTurn();
    } catch {
      // best effort
    }

    this.detachSessionEventHandlers();

    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;

    try {
      await this.closeCopilotResources(session, client);
    } catch {
      // best effort
    }
  }
}
