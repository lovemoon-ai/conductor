import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { CLAUDE_AGENT_SDK_VARIANT as CLAUDE_PROVIDER_VARIANT } from "../built-in-backends.js";
import { appendContextFilesToPrompt } from "../context-files.js";
import { PROVIDER_MEDIA_CAPABILITIES, buildClaudeContent } from "../media-adapters.js";
import {
  assertMediaCapabilities,
  defaultPromptForMedia,
  resolveTurnMedia,
} from "../media-input.js";
import {
  emitLog,
  extractLongFlagFromCommandLine,
  getBoundedEnvInt,
  isGoalStatus,
  loadEnvConfig,
  normalizeLogger,
  noteToolFinished,
  noteToolStarted,
  proxyToEnv,
  sanitizeForLog,
  withActiveTool,
} from "../shared.js";

const DEFAULT_TURN_DEADLINE_MS = 12 * 60 * 1000;
const MIN_TURN_DEADLINE_MS = 30 * 1000;
const MAX_TURN_DEADLINE_MS = 30 * 60 * 1000;
// How long an interrupted turn of the long-lived query may take to report its
// result before the process is torn down instead.
const INTERRUPT_GRACE_MS = 10 * 1000;
const DEFAULT_SETTING_SOURCES = ["user", "project", "local"];
const PERMISSION_MODES = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]);
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

function waitForever() {
  return new Promise(() => {});
}

function buildClaudeUserMessage(promptText, media, uuid) {
  return {
    type: "user",
    message: {
      role: "user",
      content: media.length ? buildClaudeContent(promptText, media) : promptText,
    },
    parent_tool_use_id: null,
    ...(uuid ? { uuid } : {}),
  };
}

async function* buildClaudeInput(promptText, media) {
  yield buildClaudeUserMessage(promptText, media);
}

/**
 * The prompt stream of a long-lived query. It stays open between turns: claude
 * only winds a print-mode process down (killing background subagents after its
 * wait ceiling) once its input is closed.
 */
function createInputQueue() {
  const buffer = [];
  let waiter = null;
  let closed = false;
  const finish = () => {
    closed = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value: undefined, done: true });
    }
  };
  return {
    push(message) {
      if (closed) {
        return false;
      }
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: message, done: false });
      } else {
        buffer.push(message);
      }
      return true;
    },
    close: finish,
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (buffer.length) {
            return Promise.resolve({ value: buffer.shift(), done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        return: () => {
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function resultUserMessageUuids(resultMessage) {
  if (Array.isArray(resultMessage?.user_message_uuids)) {
    return resultMessage.user_message_uuids;
  }
  return resultMessage?.user_message_uuid ? [resultMessage.user_message_uuid] : [];
}

function createTurnError(message, extras = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(extras)) {
    error[key] = value;
  }
  return error;
}

/**
 * Per-turn usage summed from streamed assistant messages (one entry per API
 * response), on top of `base` (what an earlier result of the turn covered).
 */
function sumStreamedUsage(usageByMessageId, base = null) {
  if (!usageByMessageId.size) {
    return base;
  }
  const total = { ...base };
  for (const usage of usageByMessageId.values()) {
    for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]) {
      const value = Number(usage?.[key]);
      if (Number.isFinite(value)) {
        total[key] = (total[key] || 0) + value;
      }
    }
  }
  return total;
}

/**
 * A finished turn's usage. `usage` covers only the main loop's last segment, while
 * `modelUsage` accumulates every API call the query's process made (all segments,
 * subagents and earlier turns of a long-lived query), so prefer its sum minus `base`,
 * the total at the end of the previous turn.
 */
function resultUsage(resultMessage, base = null) {
  const total = modelUsageTotal(resultMessage);
  if (!total) {
    return resultMessage.usage ? { ...resultMessage.usage } : null;
  }
  // /clear resets the running total; a total below its base starts over.
  if (!base || Object.keys(base).some((key) => !(total[key] >= base[key]))) {
    return total;
  }
  const delta = {};
  for (const [key, value] of Object.entries(total)) {
    delta[key] = value - base[key];
  }
  return delta;
}

function modelUsageTotal(resultMessage) {
  const total = {};
  for (const entry of Object.values(resultMessage.modelUsage || {})) {
    for (const [from, to] of [
      ["inputTokens", "input_tokens"],
      ["cacheCreationInputTokens", "cache_creation_input_tokens"],
      ["cacheReadInputTokens", "cache_read_input_tokens"],
      ["outputTokens", "output_tokens"],
    ]) {
      const value = Number(entry?.[from]);
      if (Number.isFinite(value)) {
        total[to] = (total[to] || 0) + value;
      }
    }
  }
  return Object.keys(total).length ? total : null;
}

function normalizeClaudeBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "claude-code") {
    return "claude";
  }
  return normalized || "claude";
}

function normalizeList(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSettingSources(value) {
  const normalized = normalizeList(value);
  return normalized && normalized.length > 0 ? normalized : [...DEFAULT_SETTING_SOURCES];
}

function normalizePermissionMode(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return PERMISSION_MODES.has(normalized) ? normalized : DEFAULT_PERMISSION_MODE;
}

// Mirrors claude's own root gate byte for byte:
//
//   permissionMode === "bypassPermissions" || dangerouslySkipPermissions
//     ? getuid() === 0 && process.env.IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP
//       -> "--dangerously-skip-permissions cannot be used with root/sudo
//           privileges for security reasons" + exit(1)
//
// Two different env idioms in that one line, and both are load-bearing:
// IS_SANDBOX is a *strict* `=== "1"` compare, while CLAUDE_CODE_BUBBLEWRAP goes
// through claude's loose truthy parser (`1|true|yes|on`, trimmed+lowercased).
// Do not "helpfully" accept IS_SANDBOX=true here — claude would still refuse,
// and the user would get no hint telling them why.
export function isClaudeRootPermissionRestricted(env = process.env) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return false;
  }
  if (env?.IS_SANDBOX === "1") {
    return false;
  }
  const bubblewrap = String(env?.CLAUDE_CODE_BUBBLEWRAP ?? "").trim().toLowerCase();
  return !["1", "true", "yes", "on"].includes(bubblewrap);
}

// The configured mode is used as-is, including on root. We used to downgrade
// bypassPermissions -> acceptEdits for root, but a headless session has no one
// to approve prompts, so acceptEdits silently denied every Bash command and
// every read outside cwd: the task "ran" and could do nothing. Instead we keep
// the mode and flag `rootSandboxRequired` so the caller can tell the user to
// opt in with IS_SANDBOX=1 (or run as a regular user).
export function resolveClaudePermissionPolicy(options = {}, env = process.env) {
  const permissionMode = normalizePermissionMode(options.permissionMode);
  // A configured value we don't recognize still falls back to the default (a
  // typo must never take the session down), but the caller reports it so the
  // user finds out their config line is doing nothing.
  const rawMode = typeof options.permissionMode === "string" ? options.permissionMode.trim() : "";
  const invalidMode = rawMode && !PERMISSION_MODES.has(rawMode) ? rawMode : "";
  const rootRestricted = isClaudeRootPermissionRestricted(env);
  const bypass = permissionMode === DEFAULT_PERMISSION_MODE;
  return {
    permissionMode,
    // A non-bypass mode the user picked on purpose never needs the escape
    // flag, and as root it would only trip claude's gate.
    allowDangerouslySkipPermissions:
      bypass || (options.allowDangerouslySkipPermissions === true && !rootRestricted),
    rootSandboxRequired: bypass && rootRestricted,
    invalidMode,
  };
}

// True when a configured claude command line would hit claude's root gate:
// it asks for bypass (the flag, or `--permission-mode bypassPermissions`) and
// the process env doesn't opt out.
export function claudeCommandNeedsRootSandbox(commandLine, env = process.env) {
  const command = typeof commandLine === "string" ? commandLine : "";
  if (!command.trim()) {
    return false;
  }
  const bypass = /(^|\s)--dangerously-skip-permissions(?=\s|$)/.test(command)
    || extractLongFlagFromCommandLine(command, "permission-mode") === DEFAULT_PERMISSION_MODE;
  return bypass && isClaudeRootPermissionRestricted(env);
}

// User-facing hint shown in the task chat (and the PTY terminal) when claude
// is about to be started as root in bypass mode without IS_SANDBOX=1.
export function buildClaudeRootSandboxNotice({ configFile } = {}) {
  const configPath = typeof configFile === "string" && configFile.trim()
    ? configFile.trim()
    : "~/.conductor/config.yaml";
  return [
    "⚠️ 当前 conductor 以 root 用户运行 claude。Claude Code 禁止 root 使用 bypassPermissions（--dangerously-skip-permissions），本会话的请求会直接失败。",
    "",
    `如果这台机器是隔离环境（容器 / 虚机），请在 ${configPath} 中加入下面的配置，然后重启 daemon：`,
    "",
    "```yaml",
    "envs:",
    "  IS_SANDBOX: \"1\"",
    "```",
    "",
    "注意值必须是字符串 \"1\"。设置后 claude 会以 root 身份直接执行命令、不再请求确认；如果不是隔离环境，建议改用普通用户运行 daemon。",
  ].join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function contentBlocks(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

function extractAssistantText(message) {
  return contentBlocks(message)
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

function extractResultErrorMessage(resultMessage) {
  if (!resultMessage || typeof resultMessage !== "object") {
    return "Claude turn failed";
  }
  const errors = Array.isArray(resultMessage.errors) ? resultMessage.errors.filter(Boolean) : [];
  if (errors.length > 0) {
    return String(errors[0]);
  }
  const subtype = typeof resultMessage.subtype === "string" ? resultMessage.subtype.trim() : "";
  if (subtype) {
    return `Claude turn failed (${subtype})`;
  }
  return "Claude turn failed";
}

function toolPhaseForName(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized) {
    return "tool_call";
  }
  if (normalized.includes("bash") || normalized.includes("command") || normalized.includes("shell")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("multiedit") ||
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

function statusLineForPhase(phase, toolName = "") {
  switch (phase) {
    case "context_compaction":
      return "claude compacting context";
    case "command_execution":
      return "claude running command";
    case "file_update":
      return "claude editing files";
    case "workspace_inspection":
      return "claude reading workspace";
    case "web_lookup":
      return "claude browsing";
    case "message_aggregation":
      return "claude composing reply";
    case "task_progress":
      return toolName ? `claude running ${toolName}` : "claude running task";
    case "tool_call":
      return toolName ? `claude calling ${toolName}` : "claude calling tool";
    default:
      return "claude is working";
  }
}

function sanitizeSummary(value, maxLen = 180) {
  return sanitizeForLog(value, maxLen);
}

export class ClaudeAgentSdkSession extends EventEmitter {
  // Capability advertised via getSnapshot().capabilities so worker proxies
  // can short-circuit runGoal without an IPC round trip. Claude exposes
  // native `/goal` and `/compact` slash commands, so both are true.
  static capabilities = Object.freeze({
    goal: true,
    compact: true,
    clear: true,
    media: PROVIDER_MEDIA_CAPABILITIES[CLAUDE_PROVIDER_VARIANT],
  });

  getCapabilities() {
    return { ...ClaudeAgentSdkSession.capabilities };
  }

  constructor(backend, options = {}) {
    super();
    this.backend = normalizeClaudeBackend(backend);
    // Lift `--effort` out of the configured allow_cli_list command string
    // when the caller didn't pass it as a structured option. This keeps
    // claude-specific flags out of the generic fire/serve-ai layer while
    // still honoring user config like `claude --model fable --effort low`.
    // An explicit `options.effort` always wins.
    if (options.effort === undefined && typeof options.commandLine === "string") {
      const effortFromCommandLine = extractLongFlagFromCommandLine(options.commandLine, "effort");
      if (effortFromCommandLine) {
        options = { ...options, effort: effortFromCommandLine };
      }
    }
    // Same for `--permission-mode`, so `claude --permission-mode acceptEdits`
    // in allow_cli_list picks the mode without new plumbing.
    if (options.permissionMode === undefined && typeof options.commandLine === "string") {
      const modeFromCommandLine = extractLongFlagFromCommandLine(options.commandLine, "permission-mode");
      if (modeFromCommandLine) {
        options = { ...options, permissionMode: modeFromCommandLine };
      }
    }
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
    this.manualResumeReady = Boolean(this.sessionId);
    this.currentTurn = null;
    this.liveQuery = null;
    this.lastResult = null;
    this.rateLimitInfo = null;
    this.currentTurnStatus = null;
    this.currentTurnActivityAt = 0;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.turnDeadlineMs = getBoundedEnvInt(
      "CONDUCTOR_TURN_DEADLINE_MS",
      DEFAULT_TURN_DEADLINE_MS,
      MIN_TURN_DEADLINE_MS,
      MAX_TURN_DEADLINE_MS,
    );
    this.sdkModulePromise = null;

    const envConfig = loadEnvConfig(options.configFile);
    const proxyEnv = proxyToEnv(envConfig);
    const extraEnv = envConfig && typeof envConfig === "object" ? { ...envConfig, ...proxyEnv } : proxyEnv;
    this.env = {
      ...extraEnv,
      ...(options.env && typeof options.env === "object" ? options.env : {}),
    };
    if (!this.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
      this.env.CLAUDE_AGENT_SDK_CLIENT_APP = "conductor-ai-sdk/0.0.0";
    }

    // Resolved once at boot (options and env are both fixed by now) so the
    // config warning lands at session start instead of once per turn.
    this.permissionPolicy = resolveClaudePermissionPolicy(this.options, { ...process.env, ...this.env });
    if (this.permissionPolicy.invalidMode) {
      this.trace(
        `WARN unknown permission mode ${JSON.stringify(this.permissionPolicy.invalidMode)} in config; `
          + `using ${this.permissionPolicy.permissionMode} instead `
          + `(valid: ${[...PERMISSION_MODES].join(", ")})`,
      );
    }
    // Shown to the user by fire as a chat message (see getSnapshot().notices):
    // claude will refuse to start, and a daemon log line alone is invisible.
    this.notices = [];
    if (this.permissionPolicy.rootSandboxRequired) {
      this.trace(
        "WARN running as root without IS_SANDBOX=1; claude will refuse bypassPermissions "
          + "(set envs.IS_SANDBOX: \"1\" in the conductor config, or run as a regular user)",
      );
      this.notices.push(buildClaudeRootSandboxNotice({
        configFile: options.configFile || this.env.CONDUCTOR_CONFIG || process.env.CONDUCTOR_CONFIG,
      }));
    }
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [agent-sdk] ${message}`);
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
      provider: CLAUDE_PROVIDER_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId || undefined,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: this.manualResumeReady,
      manualResume: this.sessionId
        ? {
            ready: this.manualResumeReady,
            command: `claude --resume ${this.sessionId}`,
          }
        : null,
      currentTurnStatus: this.getCurrentTurnStatus(),
      capabilities: this.getCapabilities(),
      notices: [...this.notices],
    };
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  getCurrentTurnStatus() {
    return withActiveTool(this.currentTurnStatus, this.currentTurn);
  }

  async ensureSessionInfo() {
    return this.getSessionInfo();
  }

  async getSessionUsageSummary() {
    return {
      sessionId: this.sessionId || undefined,
      sessionFilePath: undefined,
      totalCostUsd: Number.isFinite(Number(this.lastResult?.total_cost_usd))
        ? Number(this.lastResult.total_cost_usd)
        : undefined,
      usage: this.lastResult?.usage ? { ...this.lastResult.usage } : null,
      modelUsage: this.lastResult?.modelUsage ? { ...this.lastResult.modelUsage } : null,
      rateLimits: this.rateLimitInfo ? { ...this.rateLimitInfo } : null,
      manualResume: this.sessionId
        ? {
            ready: this.manualResumeReady,
            command: `claude --resume ${this.sessionId}`,
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
      source: CLAUDE_PROVIDER_VARIANT,
      reply_in_progress: true,
      replyTo: this.getCurrentReplyTarget(),
      phase: "turn_started",
      status_line: "claude is working",
      thread_id: this.sessionId || undefined,
    });
  }

  async emitWorkingStatus(payload, onProgress = null) {
    const normalized = {
      source: CLAUDE_PROVIDER_VARIANT,
      reply_in_progress: Boolean(payload?.reply_in_progress),
      replyTo: payload?.replyTo || this.getCurrentReplyTarget(),
      state: payload?.state,
      phase: payload?.phase,
      status_line: payload?.status_line,
      status_done_line: payload?.status_done_line,
      reply_preview: payload?.reply_preview,
      thread_id: this.sessionId || undefined,
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
      source: CLAUDE_PROVIDER_VARIANT,
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
    const error = new Error("Claude Agent SDK session closed");
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

  updateSessionInfo(sessionId) {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) {
      return;
    }
    const changed = this.sessionId !== normalizedSessionId;
    this.sessionId = normalizedSessionId;
    this.manualResumeReady = true;
    const modelUsage = this.lastResult?.modelUsage && typeof this.lastResult.modelUsage === "object"
      ? this.lastResult.modelUsage
      : null;
    const resolvedModel =
      typeof modelUsage?.model === "string" && modelUsage.model.trim()
        ? modelUsage.model.trim()
        : typeof this.options.model === "string" && this.options.model.trim()
          ? this.options.model.trim()
          : undefined;
    this.sessionInfo = {
      ...(this.sessionInfo || {}),
      backend: this.backend,
      sessionId: normalizedSessionId,
      model: resolvedModel,
    };
    if (changed) {
      this.trace(`session ready id=${normalizedSessionId}`);
      this.emit("session", this.getSessionInfo());
    }
  }

  maybeEmitAuthRequired(message, extraMessage = "") {
    const normalizedMessage = `${normalizeText(message)} ${normalizeText(extraMessage)}`.trim().toLowerCase();
    if (!normalizedMessage || (!normalizedMessage.includes("auth") && !normalizedMessage.includes("login"))) {
      return;
    }
    this.emit("auth_required", {
      reason: "login_required",
      message: extraMessage || message,
    });
  }

  buildSdkOptions(abortController) {
    const { permissionMode } = this.permissionPolicy;
    const options = {
      abortController,
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
      },
      permissionMode,
      settingSources: normalizeSettingSources(this.options.settingSources),
      persistSession: this.options.persistSession !== false,
    };

    if (this.permissionPolicy.allowDangerouslySkipPermissions) {
      options.allowDangerouslySkipPermissions = true;
    }
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const passthroughKeys = [
      "additionalDirectories",
      "agent",
      "agents",
      "allowedTools",
      "betas",
      "debug",
      "debugFile",
      "disallowedTools",
      "effort",
      "executable",
      "executableArgs",
      "extraArgs",
      "fallbackModel",
      "forkSession",
      "maxBudgetUsd",
      "maxThinkingTokens",
      "maxTurns",
      "mcpServers",
      "model",
      "pathToClaudeCodeExecutable",
      "permissionPromptToolName",
      "plugins",
      "resumeSessionAt",
      "sandbox",
      "settings",
      "strictMcpConfig",
      "systemPrompt",
      "thinking",
      "tools",
      "outputFormat",
    ];
    for (const key of passthroughKeys) {
      const value = this.options[key];
      if (value !== undefined) {
        options[key] = value;
      }
    }

    const allowedTools = normalizeList(this.options.allowedTools);
    if (allowedTools) {
      options.allowedTools = allowedTools;
    }
    const disallowedTools = normalizeList(this.options.disallowedTools);
    if (disallowedTools) {
      options.disallowedTools = disallowedTools;
    }

    if (
      typeof this.options.sessionId === "string" &&
      this.options.sessionId.trim() &&
      (!this.sessionId || this.options.forkSession === true)
    ) {
      options.sessionId = this.options.sessionId.trim();
    }

    return options;
  }

  async getSdkModule() {
    if (this.sdkModulePromise) {
      return this.sdkModulePromise;
    }
    if (this.options.sdkModule && typeof this.options.sdkModule === "object") {
      this.sdkModulePromise = Promise.resolve(this.options.sdkModule);
      return this.sdkModulePromise;
    }
    this.sdkModulePromise = import("@anthropic-ai/claude-agent-sdk");
    return this.sdkModulePromise;
  }

  async handleSdkMessage(message, currentTurn, { onProgress }) {
    currentTurn.items.push(message);
    switch (message?.type) {
      case "system": {
        if (message.subtype === "init") {
          this.updateSessionInfo(message.session_id || message.sessionId);
          return;
        }
        if (message.subtype === "compact_boundary") {
          currentTurn.compactMetadata =
            message.compact_metadata && typeof message.compact_metadata === "object"
              ? { ...message.compact_metadata }
              : {};
          return;
        }
        if (message.subtype === "status" && message.compact_result === "failed") {
          currentTurn.compactError = normalizeText(message.compact_error) || "compaction failed";
        }
        if (message.subtype === "status" && message.status === "compacting") {
          await this.emitWorkingStatus(
            {
              phase: "context_compaction",
              reply_in_progress: true,
              status_line: statusLineForPhase("context_compaction"),
            },
            onProgress,
          );
          return;
        }
        if (message.subtype === "task_started") {
          await this.emitWorkingStatus(
            {
              phase: "task_progress",
              reply_in_progress: true,
              status_line: sanitizeSummary(message.description) || statusLineForPhase("task_progress"),
            },
            onProgress,
          );
          return;
        }
        if (message.subtype === "task_progress") {
          const statusLine =
            sanitizeSummary(message.summary || message.description) || statusLineForPhase("task_progress");
          await this.emitWorkingStatus(
            {
              phase: "task_progress",
              reply_in_progress: true,
              status_line: statusLine,
            },
            onProgress,
          );
        }
        return;
      }
      case "tool_progress": {
        const phase = toolPhaseForName(message.tool_name);
        await this.emitWorkingStatus(
          {
            phase,
            reply_in_progress: true,
            status_line: statusLineForPhase(phase, message.tool_name),
          },
          onProgress,
        );
        return;
      }
      case "tool_use_summary": {
        await this.emitWorkingStatus(
          {
            phase: "tool_call",
            reply_in_progress: true,
            status_line: sanitizeSummary(message.summary) || statusLineForPhase("tool_call"),
          },
          onProgress,
        );
        return;
      }
      case "auth_status": {
        const output = Array.isArray(message.output) ? message.output.join("\n") : "";
        this.maybeEmitAuthRequired(output, message.error || output);
        await this.emitWorkingStatus(
          {
            phase: "auth",
            reply_in_progress: true,
            status_line: message.isAuthenticating ? "claude authenticating" : statusLineForPhase("tool_call"),
          },
          onProgress,
        );
        return;
      }
      case "assistant": {
        this.updateSessionInfo(message.session_id || message.sessionId);
        if (message.message?.id && message.message.usage) {
          currentTurn.usageByMessageId.set(message.message.id, message.message.usage);
        }
        for (const block of contentBlocks(message.message)) {
          if (block?.type === "tool_use") {
            noteToolStarted(currentTurn, block.id, block.name, block.input);
          }
        }
        // Subagent narration (parent_tool_use_id set) is not a reply to the user.
        const text = message.parent_tool_use_id ? "" : extractAssistantText(message.message);
        if (!text) {
          return;
        }
        currentTurn.fullText = text;
        if (currentTurn.suppressReply) {
          return;
        }
        currentTurn.emittedAssistantMessage = true;
        await this.emitWorkingStatus(
          {
            phase: "message_aggregation",
            reply_in_progress: true,
            status_line: statusLineForPhase("message_aggregation"),
            reply_preview: sanitizeSummary(text, 120),
          },
          onProgress,
        );
        await this.emitAssistantMessage(text);
        return;
      }
      case "user":
        for (const block of contentBlocks(message.message)) {
          if (block?.type === "tool_result") {
            noteToolFinished(currentTurn, block.tool_use_id);
          }
        }
        return;
      case "conversation_reset":
        // Emitted by /clear (and other fresh-session flows): the CLI mounted a
        // new transcript, so this is the authoritative "context cleared" signal.
        currentTurn.conversationReset = normalizeText(message.new_conversation_id) || "";
        this.updateSessionInfo(currentTurn.conversationReset);
        return;
      case "rate_limit_event":
        this.updateSessionInfo(message.session_id || message.sessionId);
        this.rateLimitInfo =
          message.rate_limit_info && typeof message.rate_limit_info === "object"
            ? { ...message.rate_limit_info }
            : null;
        return;
      case "result":
        this.updateSessionInfo(message.session_id || message.sessionId);
        this.lastResult = message;
        currentTurn.resultMessage = message;
        // Its modelUsage covers everything streamed so far.
        currentTurn.usageByMessageId.clear();
        return;
      default:
        return;
    }
  }

  async interruptCurrentTurn() {
    const currentTurn = this.currentTurn;
    if (!currentTurn) {
      return false;
    }
    const { liveQuery } = currentTurn;
    if (liveQuery) {
      // The interrupted turn reports its own result; tear the process down only
      // if it does not, so a stuck CLI cannot hold the turn open.
      try {
        await liveQuery.query.interrupt?.();
      } catch {
        // best effort
      }
      if (this.currentTurn === currentTurn) {
        const timer = setTimeout(() => {
          if (this.currentTurn === currentTurn) {
            this.closeLiveQuery(liveQuery);
          }
        }, INTERRUPT_GRACE_MS);
        timer.unref?.();
      }
      return true;
    }
    try {
      await currentTurn.query?.interrupt?.();
    } catch {
      // best effort
    }
    try {
      currentTurn.abortController?.abort?.();
    } catch {
      // best effort
    }
    try {
      currentTurn.query?.close?.();
    } catch {
      // best effort
    }
    return true;
  }

  createTurnState({ suppressReply = false, onProgress = null } = {}) {
    return {
      abortController: null,
      liveQuery: null,
      onProgress,
      settle: null,
      suppressReply,
      compactMetadata: null,
      compactError: "",
      conversationReset: "",
      emittedAssistantMessage: false,
      fullText: "",
      items: [],
      query: null,
      resultMessage: null,
      terminalWorkingStatusEmitted: false,
      usageBase: null,
      usageByMessageId: new Map(),
      uuid: "",
    };
  }

  /**
   * One claude process per session, fed through a prompt stream that stays
   * open between turns. A one-shot string prompt closes claude's input at once,
   * and claude then kills background subagents 10 minutes after the main
   * agent's turn ends (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS). Kept open, the
   * subagents run to completion and claude starts its own follow-up turn on
   * their notifications.
   */
  ensureLiveQuery(sdkModule) {
    if (this.liveQuery && !this.liveQuery.ended) {
      return this.liveQuery;
    }
    const abortController = new AbortController();
    const liveQuery = {
      abortController,
      backgroundTurn: null,
      ended: false,
      input: createInputQueue(),
      query: null,
      usageBase: null,
    };
    liveQuery.query = sdkModule.query({
      prompt: liveQuery.input,
      options: this.buildSdkOptions(abortController),
    });
    this.liveQuery = liveQuery;
    void this.pumpLiveQuery(liveQuery);
    return liveQuery;
  }

  closeLiveQuery(liveQuery) {
    liveQuery.ended = true;
    if (this.liveQuery === liveQuery) {
      this.liveQuery = null;
    }
    liveQuery.input.close();
    try {
      liveQuery.abortController.abort();
    } catch {
      // best effort
    }
    try {
      liveQuery.query?.close?.();
    } catch {
      // best effort
    }
  }

  settleTurn(turn, error, resultMessage = null) {
    const settle = turn.settle;
    turn.settle = null;
    settle?.(error, resultMessage);
  }

  async pumpLiveQuery(liveQuery) {
    let failure = null;
    try {
      for await (const message of liveQuery.query) {
        await this.dispatchLiveMessage(liveQuery, message);
      }
    } catch (error) {
      failure = error;
    }
    this.closeLiveQuery(liveQuery);
    const turn = this.currentTurn;
    if (turn?.liveQuery === liveQuery && turn.settle) {
      this.settleTurn(turn, failure, turn.resultMessage);
    } else if (failure && !this.closeRequested) {
      this.trace(`claude process ended between turns: ${failure?.message || failure}`);
    }
    const backgroundTurn = liveQuery.backgroundTurn;
    liveQuery.backgroundTurn = null;
    if (backgroundTurn) {
      await this.finishBackgroundTurn(backgroundTurn, null, failure);
    }
  }

  /**
   * Routes the long-lived query's output. A result ends the pending turn when it
   * echoes that turn's user message uuid (or echoes none while no follow-up turn
   * of claude's own is running); everything else is a background turn, e.g.
   * claude answering a finished subagent's notification between user turns.
   */
  async dispatchLiveMessage(liveQuery, message) {
    const turn =
      this.currentTurn?.liveQuery === liveQuery && this.currentTurn.settle ? this.currentTurn : null;
    const backgroundTurn = liveQuery.backgroundTurn;
    if (message?.type !== "result") {
      const target = backgroundTurn || turn || (liveQuery.backgroundTurn = this.createTurnState());
      await this.handleSdkMessage(message, target, { onProgress: target.onProgress });
      return;
    }
    liveQuery.backgroundTurn = null;
    const uuids = resultUserMessageUuids(message);
    if (turn && (uuids.length ? uuids.includes(turn.uuid) : !backgroundTurn)) {
      // A background turn that folded the user's message in ends as this turn.
      if (backgroundTurn?.emittedAssistantMessage) {
        turn.emittedAssistantMessage = true;
      }
      await this.handleSdkMessage(message, turn, { onProgress: turn.onProgress });
      liveQuery.usageBase = modelUsageTotal(message) || liveQuery.usageBase;
      this.settleTurn(turn, null, message);
      return;
    }
    const target = backgroundTurn || this.createTurnState();
    await this.handleSdkMessage(message, target, {});
    await this.finishBackgroundTurn(target, message);
  }

  async finishBackgroundTurn(backgroundTurn, resultMessage, failure = null) {
    const failed = Boolean(failure) || (resultMessage && resultMessage.subtype !== "success");
    const text = normalizeText(resultMessage?.result);
    if (!failed && text && !backgroundTurn.emittedAssistantMessage) {
      await this.emitAssistantMessage(text);
    }
    // A pending user turn owns the working status.
    if (this.currentTurn) {
      return;
    }
    await this.emitTerminalWorkingStatus(
      backgroundTurn,
      failed
        ? {
            phase: "turn_failed",
            status_done_line: failure?.message || extractResultErrorMessage(resultMessage),
          }
        : { phase: "turn_completed", status_done_line: "claude finished" },
    );
  }

  async runTurn(promptText, { useInitialImages = false, media: mediaInput, contextFiles, onProgress = null, jsonSchema = null, suppressReply = false } = {}) {
    if (this.closeRequested) {
      throw this.createSessionClosedError();
    }

    const media = resolveTurnMedia(this.options, { useInitialImages, media: mediaInput });
    assertMediaCapabilities(media, this.backend, PROVIDER_MEDIA_CAPABILITIES[CLAUDE_PROVIDER_VARIANT]);
    let effectivePrompt =
      this.buildPrompt(promptText, { useInitialImages: false }) ||
      (media.length ? defaultPromptForMedia(media) : "");
    effectivePrompt = appendContextFilesToPrompt(effectivePrompt, contextFiles).prompt;
    if (!effectivePrompt) {
      return {
        text: "",
        usage: null,
        items: [],
        events: [],
      };
    }

    if (this.currentTurn) {
      throw createTurnError("Claude Agent SDK turn already running", {
        reason: "turn_already_running",
      });
    }

    const sdkModule = await this.getSdkModule();
    if (!sdkModule || typeof sdkModule.query !== "function") {
      throw new Error("Claude Agent SDK is unavailable");
    }

    if (!suppressReply) {
      this.history.push({ role: "user", content: promptText });
    }

    // Structured output is fixed when the process starts, so a jsonSchema turn
    // runs on a one-shot query of its own.
    const oneShot = Boolean(jsonSchema && typeof jsonSchema === "object");
    const abortController = oneShot ? new AbortController() : null;
    const currentTurn = this.createTurnState({ suppressReply, onProgress });
    currentTurn.abortController = abortController;
    this.currentTurn = currentTurn;
    this.markTurnStartedStatus();

    const stopTurn = () => {
      if (currentTurn.liveQuery) {
        this.closeLiveQuery(currentTurn.liveQuery);
        return;
      }
      abortController?.abort();
      currentTurn.query?.close?.();
    };
    const closeGuard = this.createCloseGuard(stopTurn);
    const turnTimeoutGuard = this.createTurnTimeoutGuard(stopTurn);

    const previousOutputFormat = this.options.outputFormat;
    if (jsonSchema && typeof jsonSchema === "object") {
      this.options.outputFormat = { type: "json_schema", schema: jsonSchema };
    }

    try {
      await this.emitWorkingStatus(
        {
          phase: "turn_started",
          reply_in_progress: true,
          status_line: "claude is working",
        },
        onProgress,
      );

      let turnResult;
      if (oneShot) {
        const query = sdkModule.query({
          prompt: media.length ? buildClaudeInput(effectivePrompt, media) : effectivePrompt,
          options: this.buildSdkOptions(abortController),
        });
        currentTurn.query = query;
        turnResult = (async () => {
          for await (const message of query) {
            await this.handleSdkMessage(message, currentTurn, { onProgress });
          }
          return currentTurn.resultMessage;
        })();
      } else {
        turnResult = new Promise((resolve, reject) => {
          currentTurn.settle = (error, message) => (error ? reject(error) : resolve(message));
        });
        const liveQuery = this.ensureLiveQuery(sdkModule);
        currentTurn.liveQuery = liveQuery;
        currentTurn.query = liveQuery.query;
        currentTurn.usageBase = liveQuery.usageBase;
        currentTurn.uuid = randomUUID();
        if (!liveQuery.input.push(buildClaudeUserMessage(effectivePrompt, media, currentTurn.uuid))) {
          this.settleTurn(currentTurn, createTurnError("Claude process input is closed", { reason: "process_exited" }));
        }
      }
      turnResult.catch(() => {});

      const resultMessage = await Promise.race([turnResult, closeGuard.promise, turnTimeoutGuard.promise]);

      if (!resultMessage) {
        throw createTurnError("Claude query ended without a result message", {
          reason: "missing_result",
        });
      }

      if (resultMessage.subtype !== "success") {
        const errorMessage = extractResultErrorMessage(resultMessage);
        this.maybeEmitAuthRequired(errorMessage, errorMessage);
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_failed",
            status_done_line: errorMessage,
          },
          onProgress,
        );
        throw createTurnError(errorMessage, {
          reason: "turn_failed",
          turnStatus: resultMessage.subtype,
          errors: Array.isArray(resultMessage.errors) ? [...resultMessage.errors] : [],
          permissionDenials: Array.isArray(resultMessage.permission_denials)
            ? [...resultMessage.permission_denials]
            : [],
          // A failed turn still spent tokens.
          usage: resultUsage(resultMessage, currentTurn.usageBase),
        });
      }

      const structuredOutput =
        jsonSchema && resultMessage.structured_output && typeof resultMessage.structured_output === "object"
          ? resultMessage.structured_output
          : null;

      const responseText =
        structuredOutput !== null
          ? JSON.stringify(structuredOutput)
          : normalizeText(resultMessage.result) ||
            currentTurn.fullText ||
            extractAssistantText(currentTurn.items.find((item) => item?.type === "assistant")?.message);

      if (!suppressReply && !currentTurn.emittedAssistantMessage && responseText) {
        await this.emitAssistantMessage(responseText);
      }

      if (!suppressReply && responseText) {
        this.history.push({ role: "assistant", content: responseText });
      }

      this.manualResumeReady = Boolean(this.sessionId);
      this.activeReplyTarget = "";

      await this.emitTerminalWorkingStatus(
        currentTurn,
        {
          phase: "turn_completed",
          status_done_line: "claude finished",
        },
        onProgress,
      );

      return {
        text: responseText,
        usage: resultUsage(resultMessage, currentTurn.usageBase),
        items: currentTurn.items,
        events: [],
        provider: this.backend,
        metadata: {
          source: CLAUDE_PROVIDER_VARIANT,
          sessionId: this.sessionId || undefined,
          totalCostUsd: Number.isFinite(Number(resultMessage.total_cost_usd))
            ? Number(resultMessage.total_cost_usd)
            : undefined,
          modelUsage: resultMessage.modelUsage ? { ...resultMessage.modelUsage } : undefined,
          structuredOutput: structuredOutput !== null ? structuredOutput : undefined,
        },
        compactMetadata: currentTurn.compactMetadata || undefined,
        compactError: currentTurn.compactError || undefined,
        conversationReset: currentTurn.conversationReset || undefined,
      };
    } catch (error) {
      // A failed turn still spent tokens; an interrupted query ends without a
      // (final) result, so fall back to the last result plus what streamed since.
      const usage =
        error?.usage ??
        sumStreamedUsage(
          currentTurn.usageByMessageId,
          currentTurn.resultMessage ? resultUsage(currentTurn.resultMessage, currentTurn.usageBase) : null,
        );
      if (error?.reason === "turn_timeout") {
        await this.interruptCurrentTurn();
      }
      if (!this.closeRequested && error?.reason !== "session_closed") {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_failed",
            status_done_line: errorMessage || "Claude turn failed",
          },
          onProgress,
        );
      }
      if (this.closeRequested && error?.reason !== "session_closed") {
        throw Object.assign(this.createSessionClosedError(), { usage });
      }
      this.maybeEmitAuthRequired(error?.message || "", error?.message || "");
      if (error && typeof error === "object") {
        error.usage = usage;
      }
      throw error;
    } finally {
      if (jsonSchema && typeof jsonSchema === "object") {
        if (previousOutputFormat !== undefined) {
          this.options.outputFormat = previousOutputFormat;
        } else {
          delete this.options.outputFormat;
        }
      }
      this.activeReplyTarget = "";
      if (this.currentTurn === currentTurn) {
        this.currentTurn = null;
      }
      closeGuard.cleanup();
      turnTimeoutGuard.cleanup();
      currentTurn.settle = null;
      if (oneShot) {
        try {
          currentTurn.query?.close?.();
        } catch {
          // best effort
        }
      }
    }
  }

  /**
   * Trigger Claude's native `/goal` slash command. Implemented by sending the
   * prompt `"/goal <objective>"` through {@link runTurn}, which the Claude
   * Agent SDK natively recognizes as a long-running goal request.
   *
   * Callers should detect support via `typeof session.runGoal === "function"`.
   * When a provider does not support goals it should leave this method
   * undefined; callers MUST surface a clear error rather than silently falling
   * back to {@link runTurn}.
   *
   * Implementation note (N8): Claude's `/goal` slash command resolves the
   * entire goal within a single `query()` iteration. {@link runTurn} drains
   * the SDK iterator to completion (`for await (const message of query)`)
   * before returning, so `turnResult.items` is the full, terminal sequence of
   * messages. If the SDK emits multiple `goal_status` items (e.g. an
   * intermediate "active" followed by a terminal "complete"), we select the
   * LAST one rather than the first so the goal's final state is reflected.
   * When no `goal_status` item is present we fall back to "active" and emit a
   * debug log; that fallback is a signal that the contract has drifted.
   *
   * @param {import("../shared.js").GoalRequest} goal
   * @param {object} [options]
   * @returns {Promise<import("../shared.js").GoalResult>}
   */
  async runGoal(goal, options = {}) {
    const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
    if (!objective) {
      throw createTurnError("runGoal requires a non-empty objective", {
        reason: "invalid_goal",
      });
    }

    const prompt = `/goal ${objective}`;
    const turnResult = await this.runTurn(prompt, options);

    const items = Array.isArray(turnResult?.items) ? turnResult.items : [];
    // Walk from the end so we settle on the LAST goal_status item the SDK
    // emitted. The single-shot `query()` iteration has been drained by
    // `runTurn`, so this is the terminal status.
    let goalStatusItem = null;
    for (let idx = items.length - 1; idx >= 0; idx -= 1) {
      const item = items[idx];
      if (!item || typeof item !== "object") {
        continue;
      }
      if (
        item.type === "goal_status" ||
        item.subtype === "goal_status" ||
        (item.goal_status && typeof item.goal_status === "object")
      ) {
        goalStatusItem = item;
        break;
      }
    }

    const parsedStatus = (() => {
      if (!goalStatusItem) {
        return null;
      }
      const candidate =
        goalStatusItem.goal_status && typeof goalStatusItem.goal_status === "object"
          ? goalStatusItem.goal_status
          : goalStatusItem;
      const status = typeof candidate?.status === "string" ? candidate.status : null;
      const id = typeof candidate?.id === "string" ? candidate.id : undefined;
      const tokenBudget =
        candidate?.tokenBudget === null || Number.isFinite(Number(candidate?.tokenBudget))
          ? candidate.tokenBudget
          : undefined;
      return { status, id, tokenBudget };
    })();

    if (!goalStatusItem) {
      // Contract drift: the SDK did not surface a goal_status item in the
      // single query iteration. Log so operators notice; downstream we
      // default to "active" so a still-running goal isn't misclassified as
      // terminal.
      this.trace(
        `runGoal: no goal_status item found in SDK message stream (${items.length} items); defaulting status to "active"`,
      );
    }

    // Validate the SDK-reported status against the known GoalStatus enum
    // before exposing it. An unknown / typo'd status (e.g. "weird") would
    // otherwise leak through and confuse downstream goal-status consumers
    // (the realtime hub uses isTerminalGoalStatus to decide when to stop
    // polling). Default to "active" so a still-running goal is not
    // misclassified as terminal.
    const rawStatus =
      typeof parsedStatus?.status === "string" ? parsedStatus.status.trim() : "";
    const validatedStatus = isGoalStatus(rawStatus) ? rawStatus : "active";

    const goalState = {
      id: parsedStatus?.id,
      threadId: this.sessionId || undefined,
      objective,
      status: validatedStatus,
      tokenBudget:
        goal?.tokenBudget !== undefined
          ? goal.tokenBudget
          : parsedStatus?.tokenBudget !== undefined
            ? parsedStatus.tokenBudget
            : null,
    };

    return {
      text: turnResult?.text || "",
      goal: goalState,
      usage: turnResult?.usage || null,
      metadata: {
        ...(turnResult?.metadata && typeof turnResult.metadata === "object" ? turnResult.metadata : {}),
        goalPrompt: prompt,
      },
    };
  }

  /**
   * Manually compact the conversation via Claude's native `/compact` slash
   * command. Custom focus instructions are forwarded as the command argument.
   * No assistant message is emitted; the caller renders the confirmation.
   *
   * @param {import("../shared.js").CompactRequest} [request]
   * @param {{ onProgress?: Function }} [options]
   * @returns {Promise<import("../shared.js").CompactResult>}
   */
  async runCompact(request = {}, { onProgress = null } = {}) {
    const instructions = normalizeText(request?.instructions).trim();
    if (!this.sessionId || this.pendingHistorySeed) {
      return { compact: { status: "noop", instructionsApplied: false }, usage: null, metadata: {} };
    }
    const turnResult = await this.runTurn(instructions ? `/compact ${instructions}` : "/compact", {
      onProgress,
      suppressReply: true,
    });
    if (/not enough messages/i.test(turnResult.compactError || "")) {
      return { compact: { status: "noop", instructionsApplied: false }, usage: turnResult.usage, metadata: turnResult.metadata };
    }
    if (turnResult.compactError) {
      throw createTurnError(`Claude compaction failed: ${turnResult.compactError}`, {
        reason: "compact_failed",
      });
    }
    const boundary = turnResult.compactMetadata;
    const preTokens = Number(boundary?.pre_tokens);
    const postTokens = Number(boundary?.post_tokens);
    return {
      compact: {
        status: boundary ? "compacted" : "noop",
        instructionsApplied: Boolean(boundary && instructions),
        preTokens: Number.isFinite(preTokens) ? preTokens : undefined,
        postTokens: Number.isFinite(postTokens) ? postTokens : undefined,
      },
      usage: turnResult.usage,
      metadata: turnResult.metadata,
    };
  }

  /**
   * Native `/clear`: the CLI handles the slash command itself and continues on
   * a new session id, so the process stays up and only the context is dropped.
   * A session id that did NOT move means the command was not handled natively.
   */
  async runClear(request = {}, { onProgress = null } = {}) {
    if (!this.sessionId || this.pendingHistorySeed) {
      return { clear: { status: "noop" }, usage: null, metadata: {} };
    }
    const previousSessionId = this.sessionId;
    const turnResult = await this.runTurn("/clear", { onProgress, suppressReply: true });
    const cleared = Boolean(
      turnResult.conversationReset || (this.sessionId && this.sessionId !== previousSessionId),
    );
    if (cleared) {
      this.history = [];
    }
    return {
      clear: {
        status: cleared ? "cleared" : "noop",
        sessionId: cleared ? this.sessionId : undefined,
      },
      usage: turnResult.usage,
      metadata: turnResult.metadata,
    };
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closeRequested = true;
    this.flushCloseWaiters();
    if (!this.currentTurn?.liveQuery) {
      await this.interruptCurrentTurn();
    }
    if (this.liveQuery) {
      this.closeLiveQuery(this.liveQuery);
    }
    this.closed = true;
  }
}
