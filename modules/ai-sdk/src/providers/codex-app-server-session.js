import { EventEmitter } from "node:events";

import { CODEX_APP_SERVER_VARIANT } from "../built-in-backends.js";
import { PROVIDER_MEDIA_CAPABILITIES, buildCodexAppServerInput } from "../media-adapters.js";
import {
  assertMediaCapabilities,
  defaultPromptForMedia,
  resolveTurnMedia,
} from "../media-input.js";
import { CodexAppServerTransport } from "../transports/codex-app-server-transport.js";
import {
  TERMINAL_GOAL_STATUSES,
  emitLog,
  getBoundedEnvInt,
  loadEnvConfig,
  normalizeLogger,
  proxyToEnv,
  sanitizeForLog,
} from "../shared.js";

const TERMINAL_GOAL_STATUSES_LOCAL = new Set(TERMINAL_GOAL_STATUSES);

function isTerminalGoalStatusLocal(status) {
  return typeof status === "string" && TERMINAL_GOAL_STATUSES_LOCAL.has(status);
}

const DEFAULT_TURN_DEADLINE_MS = 12 * 60 * 1000;
const MIN_TURN_DEADLINE_MS = 30 * 1000;
const MAX_TURN_DEADLINE_MS = 30 * 60 * 1000;

function waitForever() {
  return new Promise(() => {});
}

function isCodexBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  return normalized === "codex" || normalized === "code";
}

function normalizeCodexBackend(backend) {
  return isCodexBackend(backend) ? "codex" : String(backend || "codex").trim().toLowerCase();
}

function extractSessionConfiguredValue(params, ...keys) {
  for (const key of keys) {
    if (params && typeof params === "object" && params[key] !== undefined && params[key] !== null) {
      return params[key];
    }
  }
  const session = params?.session;
  if (session && typeof session === "object") {
    for (const key of keys) {
      if (session[key] !== undefined && session[key] !== null) {
        return session[key];
      }
    }
  }
  return undefined;
}

function injectJsonSchemaPrompt(promptText, jsonSchema) {
  const schemaText = typeof jsonSchema === "string" ? jsonSchema : JSON.stringify(jsonSchema, null, 2);
  return `You must respond with valid JSON that strictly conforms to the following JSON Schema. Do not include any markdown formatting or explanation outside the JSON object.

JSON Schema:
${schemaText}

${promptText}`;
}

function normalizeItemId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractItemId(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  return normalizeItemId(item.id || item.itemId || item.item_id);
}

function resolveItemPhase(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const candidates = new Set();
  const collectCandidate = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    candidates.add(normalized);
  };

  collectCandidate(item.type);
  collectCandidate(item.kind);
  collectCandidate(item.phase);
  collectCandidate(item.name);
  collectCandidate(item.toolName);

  if (item.reasoning || item.reasoningItem || item.summary || item.summaryText) {
    return "reasoning";
  }
  if (item.agentMessage || item.message) {
    return "assistant_message";
  }

  if (item.commandExecution || item.command || item.commandExecutionId) {
    return "command_execution";
  }
  if (item.mcpToolCall || item.toolCall || item.toolName) {
    return "mcp_tool_call";
  }

  const hasCandidate = (...values) => values.some((value) => candidates.has(value));
  const includesCandidate = (...values) =>
    [...candidates].some((candidate) => values.some((value) => candidate.includes(value)));

  if (
    hasCandidate("reasoning", "agent_reasoning", "summary_text", "summary") ||
    includesCandidate("reason", "summary")
  ) {
    return "reasoning";
  }
  if (hasCandidate("message", "agent_message", "output_text", "final_answer")) {
    return "assistant_message";
  }
  if (hasCandidate("compaction", "context_compacted", "compacted") || includesCandidate("compact")) {
    return "context_compaction";
  }
  if (
    hasCandidate("update_plan", "plan_update", "plan") ||
    includesCandidate("plan")
  ) {
    return "planning";
  }
  if (
    hasCandidate("open_page", "search", "web_search_call") ||
    includesCandidate("web_search", "open_page", "search_query", "navigate_page", "find", "image_query")
  ) {
    return "web_lookup";
  }
  if (
    hasCandidate("custom_tool_call", "function_call", "mcp_tool_call", "tool_call") ||
    includesCandidate("tool_call", "mcp", "tool")
  ) {
    if (
      includesCandidate("exec_command", "shell", "bash", "terminal", "command")
    ) {
      return "command_execution";
    }
    if (
      includesCandidate("apply_patch", "write_file", "edit_file", "replace", "patch")
    ) {
      return "file_update";
    }
    if (
      includesCandidate("search_query", "open_page", "navigate_page", "image_query", "find", "web_search")
    ) {
      return "web_lookup";
    }
    if (
      includesCandidate("read_", "list_", "rg", "cat", "view_", "read_mcp_resource", "list_mcp")
    ) {
      return "workspace_inspection";
    }
    return "tool_call";
  }
  if (
    includesCandidate("exec_command", "shell", "bash", "terminal", "command_execution", "command")
  ) {
    return "command_execution";
  }
  if (includesCandidate("apply_patch", "write_file", "edit_file", "patch")) {
    return "file_update";
  }
  if (includesCandidate("read_", "list_", "rg", "cat", "view_", "read_mcp_resource", "list_mcp")) {
    return "workspace_inspection";
  }

  return null;
}

function statusLineForPhase(phase) {
  switch (phase) {
    case "reasoning":
      return "codex reasoning";
    case "planning":
      return "codex updating plan";
    case "workspace_inspection":
      return "codex reading workspace";
    case "command_execution":
      return "codex running command";
    case "file_update":
      return "codex editing files";
    case "web_lookup":
      return "codex browsing";
    case "mcp_tool_call":
    case "tool_call":
      return "codex calling tool";
    case "context_compaction":
      return "codex compacting context";
    case "message_aggregation":
    case "assistant_message":
      return "codex composing reply";
    default:
      return "codex is working";
  }
}

function createTurnError(message, extras = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(extras)) {
    error[key] = value;
  }
  return error;
}

export class CodexAppServerSession extends EventEmitter {
  /**
   * Optional feature flags surfaced to callers via {@link getSnapshot}.
   * Treat as read-only.
   * @type {Readonly<import("../shared.js").SessionCapabilities>}
   */
  static capabilities = Object.freeze({
    goal: true,
    media: PROVIDER_MEDIA_CAPABILITIES[CODEX_APP_SERVER_VARIANT],
  });

  /**
   * @returns {import("../shared.js").SessionCapabilities}
   */
  getCapabilities() {
    return { ...CodexAppServerSession.capabilities };
  }

  constructor(backend, options = {}) {
    super();
    this.backend = normalizeCodexBackend(backend);
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    this.resumeSessionId = typeof options.resumeSessionId === "string" ? options.resumeSessionId.trim() : "";
    this.sessionId = this.resumeSessionId || "";
    this.threadPath = "";
    this.sessionInfo = null;
    this.history = Array.isArray(options.initialHistory) ? [...options.initialHistory] : [];
    this.pendingHistorySeed = this.history.length > 0;
    this.closeRequested = false;
    this.closed = false;
    this.closeWaiters = new Set();
    this.sessionMessageHandler = null;
    this.workingStatusHandler = null;
    this.activeReplyTarget = "";
    this.lastReplyTarget = "";
    this.manualResumeReady = false;
    this.nativeSessionId = "";
    this.rateLimits = null;
    this.tokenUsage = null;
    this.currentTurnStatus = null;
    this.currentTurnActivityAt = 0;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.turnDeadlineMs = getBoundedEnvInt(
      "CONDUCTOR_TURN_DEADLINE_MS",
      DEFAULT_TURN_DEADLINE_MS,
      MIN_TURN_DEADLINE_MS,
      MAX_TURN_DEADLINE_MS,
    );
    this.currentTurn = null;
    this.bootPromise = null;
    this.booted = false;

    this.goalMode = options.goalMode === true;
    this.currentGoal = null;
    // Goal-mode lifecycle is decoupled from `currentTurn` so that goal events
    // that arrive after a per-turn `turn/completed` still route correctly.
    // See `runGoal` for the shape; `null` means no goal is currently running.
    this.currentGoalRun = null;

    const envConfig = loadEnvConfig(options.configFile);
    const proxyEnv = proxyToEnv(envConfig);
    const extraEnv = envConfig && typeof envConfig === "object" ? { ...envConfig, ...proxyEnv } : proxyEnv;
    this.transport = new CodexAppServerTransport({
      cwd: this.cwd,
      env: {
        ...extraEnv,
        ...(options.env && typeof options.env === "object" ? options.env : {}),
      },
      ignoreCodexApiKey: options.ignoreCodexApiKey === true,
      logger: {
        log: (message) => {
          this.writeLog(message);
        },
      },
      commandLine: options.commandLine,
      enableGoals: this.goalMode || options.enableGoals === true,
    });
    this.transport.on("notification", ({ method, params }) => {
      void this.handleNotification(method, params);
    });
    this.transport.on("process_exit", (payload) => {
      this.handleTransportExit(payload);
    });
    this.transport.on("process_error", (payload) => {
      const error = createTurnError(payload?.message || "Codex app-server transport error", payload || {});
      this.handleTransportFailure(error);
    });
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [app-server] ${message}`);
  }

  get threadId() {
    return this.sessionId;
  }

  get threadOptions() {
    return {
      model: this.sessionInfo?.model || this.backend,
      modelProvider: this.sessionInfo?.modelProvider || undefined,
    };
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: CODEX_APP_SERVER_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId || undefined,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: this.manualResumeReady,
      manualResume: this.sessionId
        ? {
            ready: this.manualResumeReady,
            command: `codex resume ${this.sessionId}`,
          }
        : null,
      currentTurnStatus: this.getCurrentTurnStatus(),
      capabilities: this.getCapabilities(),
      pid: this.transport.pid || undefined,
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
      sessionFilePath: this.threadPath || undefined,
      tokenUsagePercent: Number.isFinite(Number(this.rateLimits?.primary?.usedPercent))
        ? Number(this.rateLimits.primary.usedPercent)
        : undefined,
      contextUsagePercent: this.resolveContextUsagePercent(),
      tokenUsage: this.tokenUsage ? { ...this.tokenUsage } : null,
      rateLimits: this.rateLimits ? { ...this.rateLimits } : null,
      manualResume: this.sessionId
        ? {
            ready: this.manualResumeReady,
            command: `codex resume ${this.sessionId}`,
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
      source: CODEX_APP_SERVER_VARIANT,
      reply_in_progress: true,
      replyTo: this.getCurrentReplyTarget(),
      phase: "turn_started",
      status_line: "codex is working",
      thread_id: this.sessionId || undefined,
    });
  }

  async failPendingTurnStart(error) {
    if (this.closeRequested || error?.reason === "session_closed") {
      return;
    }
    await this.emitWorkingStatus({
      phase: "turn_failed",
      reply_in_progress: false,
      status_done_line: error instanceof Error ? error.message : String(error),
    });
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
    await this.transport.boot();
    const params = {
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      personality: "pragmatic",
      ephemeral: false,
    };
    if (this.options.model) {
      params.model = this.options.model;
    }

    let result;
    if (this.resumeSessionId) {
      result = await this.transport.request("thread/resume", {
        ...params,
        threadId: this.resumeSessionId,
      });
    } else {
      result = await this.transport.request("thread/start", params);
    }
    this.applyThreadInfo(result, { resumeReady: Boolean(this.resumeSessionId) });
  }

  applyThreadInfo(payload, { resumeReady = false } = {}) {
    const thread = payload?.thread && typeof payload.thread === "object" ? payload.thread : payload;
    const threadId = typeof thread?.id === "string" ? thread.id.trim() : "";
    const threadPath = typeof thread?.path === "string" ? thread.path.trim() : "";
    if (!threadId) {
      return;
    }
    this.sessionId = threadId;
    this.threadPath = threadPath;
    const resolvedModel =
      typeof payload?.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : this.sessionInfo?.model || undefined;
    const resolvedModelProvider =
      typeof payload?.modelProvider === "string" && payload.modelProvider.trim()
        ? payload.modelProvider.trim()
        : typeof thread?.modelProvider === "string" && thread.modelProvider.trim()
          ? thread.modelProvider.trim()
          : this.sessionInfo?.modelProvider || undefined;
    const reasoningEffort =
      typeof payload?.reasoningEffort === "string" && payload.reasoningEffort.trim()
        ? payload.reasoningEffort.trim()
        : this.sessionInfo?.reasoningEffort || undefined;
    this.sessionInfo = {
      ...(this.sessionInfo || {}),
      backend: this.backend,
      sessionId: threadId,
      sessionFilePath: threadPath || undefined,
      model: resolvedModel,
      modelProvider: resolvedModelProvider,
      reasoningEffort,
    };
    if (resumeReady) {
      this.manualResumeReady = true;
    }
    this.trace(
      `thread ready id=${threadId} path="${sanitizeForLog(threadPath, 180)}" model="${sanitizeForLog(resolvedModel || this.backend, 80)}" provider="${sanitizeForLog(resolvedModelProvider || this.backend, 80)}"`,
    );
    this.emit("session", this.getSessionInfo());
  }

  applySessionConfigured(params) {
    const nativeSessionId = extractSessionConfiguredValue(params, "session_id", "sessionId");
    const rolloutPath = extractSessionConfiguredValue(params, "rollout_path", "rolloutPath");
    if (typeof nativeSessionId === "string" && nativeSessionId.trim()) {
      this.nativeSessionId = nativeSessionId.trim();
    }
    if (typeof rolloutPath === "string" && rolloutPath.trim()) {
      this.threadPath = rolloutPath.trim();
      if (this.sessionInfo) {
        this.sessionInfo = {
          ...this.sessionInfo,
          sessionFilePath: this.threadPath,
        };
        this.emit("session", this.getSessionInfo());
      }
    }
  }

  resolveContextUsagePercent() {
    const totalTokens = Number(this.tokenUsage?.total?.totalTokens);
    const contextWindow = Number(this.tokenUsage?.modelContextWindow);
    if (!Number.isFinite(totalTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
      return undefined;
    }
    return Math.max(0, Math.min(100, Math.round((totalTokens / contextWindow) * 100)));
  }

  normalizeWorkingStatusPayload(payload) {
    return {
      source: CODEX_APP_SERVER_VARIANT,
      reply_in_progress: Boolean(payload?.reply_in_progress),
      replyTo: payload?.replyTo || this.getCurrentReplyTarget(),
      state: payload?.state,
      phase: payload?.phase,
      status_line: payload?.status_line,
      status_done_line: payload?.status_done_line,
      reply_preview: payload?.reply_preview,
      thread_id: this.sessionId || undefined,
    };
  }

  async emitWorkingStatus(payload) {
    const normalized = this.normalizeWorkingStatusPayload(payload);
    this.updateCurrentTurnStatus(normalized);
    const snapshot = this.getCurrentTurnStatus();
    if (typeof this.workingStatusHandler === "function") {
      await this.workingStatusHandler(snapshot);
    }
    this.emit("working_status", snapshot);
  }

  /**
   * Idempotent terminal working-status clear (see BUG-R6-01 lesson). The
   * "reply_in_progress:false" signal that unsticks the composer must be emitted
   * from a reliable, always-arriving path, and multiple paths emitting it must
   * be a safe no-op. A one-time guard on the turn object ensures we clear
   * exactly once regardless of how many code paths reach here.
   */
  async emitTurnCompletedStatus(
    currentTurn,
    { phase = "turn_completed", status_done_line = "codex finished" } = {},
  ) {
    if (currentTurn && currentTurn.terminalStatusEmitted) {
      return;
    }
    if (currentTurn) {
      currentTurn.terminalStatusEmitted = true;
    }
    await this.emitWorkingStatus({
      phase,
      reply_in_progress: false,
      status_done_line,
    });
  }

  async emitAssistantMessage(text) {
    this.touchTurnActivity();
    const payload = {
      text,
      preserveWhitespace: true,
      source: CODEX_APP_SERVER_VARIANT,
      replyTo: this.getCurrentReplyTarget(),
      sessionId: this.sessionId || undefined,
      sessionFilePath: this.threadPath || undefined,
      timestamp: new Date().toISOString(),
    };
    if (typeof this.sessionMessageHandler === "function") {
      await this.sessionMessageHandler(payload);
    }
    this.emit("assistant_message", payload);
  }

  async finalizeActiveAssistantMessage(currentTurn = this.currentTurn, { messageId = "" } = {}) {
    if (!currentTurn) {
      return false;
    }
    const finalizedMessageId = normalizeItemId(messageId) || currentTurn.activeAssistantMessageId || "";
    const activeMessageId = currentTurn.activeAssistantMessageId || "";
    if (finalizedMessageId && activeMessageId && activeMessageId !== finalizedMessageId) {
      return false;
    }
    const text = currentTurn.activeAssistantMessageText || "";
    currentTurn.activeAssistantMessageText = "";
    if (!finalizedMessageId || !activeMessageId || activeMessageId === finalizedMessageId) {
      currentTurn.activeAssistantMessageId = "";
    }
    if (!text) {
      return false;
    }
    await this.emitAssistantMessage(text);
    return true;
  }

  createSessionClosedError() {
    const error = new Error("Codex app-server session closed");
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

  createCloseGuard() {
    if (this.closeRequested) {
      return {
        promise: Promise.reject(this.createSessionClosedError()),
        cleanup: () => {},
      };
    }
    let waiter = null;
    const promise = new Promise((_, reject) => {
      waiter = () => {
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

  createTurnTimeoutGuard() {
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

  getCurrentTurn() {
    return this.currentTurn;
  }

  ensureCurrentTurn(params) {
    const currentTurn = this.currentTurn;
    if (!currentTurn) {
      return null;
    }
    const turnId = typeof params?.turnId === "string" ? params.turnId.trim() : "";
    if (!turnId) {
      return currentTurn;
    }
    if (currentTurn.turnId && currentTurn.turnId !== turnId) {
      // In goal mode, the second turn's delta may arrive before
      // `turn/started` for that turn. Adopt the new turnId in that case so
      // the delta isn't dropped (the caller is presumed to be in goal mode
      // because non-goal turns spawn a fresh `currentTurn` per call).
      if (currentTurn.goalMode) {
        currentTurn.turnId = turnId;
        return currentTurn;
      }
      return null;
    }
    if (!currentTurn.turnId) {
      // First event we've seen for this turn — bind the id eagerly so later
      // events match. Particularly important for goal mode where multiple
      // turns share the same `currentTurn`.
      currentTurn.turnId = turnId;
    }
    return currentTurn;
  }

  async queueAssistantDelta(delta, { messageId = "" } = {}) {
    const currentTurn = this.currentTurn;
    if (!currentTurn) {
      return;
    }
    const normalizedMessageId = normalizeItemId(messageId);
    if (
      normalizedMessageId &&
      currentTurn.activeAssistantMessageId &&
      currentTurn.activeAssistantMessageId !== normalizedMessageId
    ) {
      await this.finalizeActiveAssistantMessage(currentTurn, {
        messageId: currentTurn.activeAssistantMessageId,
      });
    }
    if (normalizedMessageId) {
      currentTurn.activeAssistantMessageId = normalizedMessageId;
    }
    currentTurn.fullText += delta;
    currentTurn.activeAssistantMessageText += delta;
  }

  async handleNotification(method, params = {}) {
    if (this.closeRequested) {
      return;
    }
    switch (method) {
      case "thread/started":
        this.applyThreadInfo(params, { resumeReady: Boolean(this.resumeSessionId) });
        return;
      case "sessionConfigured":
      case "session_configured":
        this.applySessionConfigured(params);
        return;
      case "turn/started": {
        const currentTurn = this.getCurrentTurn();
        if (!currentTurn) {
          return;
        }
        const turnId =
          typeof params?.turn?.id === "string"
            ? params.turn.id.trim()
            : typeof params?.turnId === "string"
              ? params.turnId.trim()
              : "";
        if (turnId) {
          currentTurn.turnId = turnId;
        }
        // Flush any deltas queued for this turn before `turn/started`.
        // This races between the server emitting a delta and the
        // `turn/started` notification (common for goal mode's 2nd+ turn).
        if (turnId && this.currentGoalRun && this.currentGoalRun.pendingDeltasByTurnId) {
          const queue = this.currentGoalRun.pendingDeltasByTurnId.get(turnId);
          if (queue && queue.length > 0) {
            this.currentGoalRun.pendingDeltasByTurnId.delete(turnId);
            for (const queued of queue) {
              await this.queueAssistantDelta(queued.delta, { messageId: queued.messageId });
            }
          }
        }
        await this.emitWorkingStatus({
          phase: "turn_started",
          reply_in_progress: true,
          status_line: "codex is working",
        });
        return;
      }
      case "item/started": {
        const currentTurn = this.ensureCurrentTurn(params);
        if (!currentTurn) {
          return;
        }
        const phase = resolveItemPhase(params?.item);
        if (!phase) {
          return;
        }
        if (phase === "assistant_message") {
          const nextMessageId = extractItemId(params?.item);
          if (
            nextMessageId &&
            currentTurn.activeAssistantMessageId &&
            currentTurn.activeAssistantMessageId !== nextMessageId
          ) {
            await this.finalizeActiveAssistantMessage(currentTurn, {
              messageId: currentTurn.activeAssistantMessageId,
            });
          }
          if (nextMessageId) {
            currentTurn.activeAssistantMessageId = nextMessageId;
          }
        }
        await this.emitWorkingStatus({
          phase: phase === "assistant_message" ? "message_aggregation" : phase,
          reply_in_progress: true,
          status_line: statusLineForPhase(phase === "assistant_message" ? "message_aggregation" : phase),
        });
        return;
      }
      case "item/completed": {
        const currentTurn = this.ensureCurrentTurn(params);
        if (!currentTurn) {
          return;
        }
        const phase = resolveItemPhase(params?.item);
        if (phase !== "assistant_message") {
          return;
        }
        const completedMessageId = extractItemId(params?.item) || currentTurn.activeAssistantMessageId || "";
        await this.finalizeActiveAssistantMessage(currentTurn, {
          messageId: completedMessageId,
        });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        await this.emitWorkingStatus({
          phase: "reasoning",
          reply_in_progress: true,
          status_line: statusLineForPhase("reasoning"),
        });
        return;
      case "item/commandExecution/outputDelta":
        await this.emitWorkingStatus({
          phase: "command_execution",
          reply_in_progress: true,
          status_line: statusLineForPhase("command_execution"),
        });
        return;
      case "item/mcpToolCall/progress":
        await this.emitWorkingStatus({
          phase: "mcp_tool_call",
          reply_in_progress: true,
          status_line: statusLineForPhase("mcp_tool_call"),
        });
        return;
      case "item/agentMessage/delta": {
        const delta = typeof params?.delta === "string" ? params.delta : "";
        const messageId = normalizeItemId(params?.itemId || params?.item_id);
        if (!delta) {
          return;
        }
        const currentTurn = this.ensureCurrentTurn(params);
        if (!currentTurn) {
          // Goal mode race: delta arrived for a turn we haven't seen
          // `turn/started` for yet. Queue it; we'll flush in `turn/started`.
          const deltaTurnId = typeof params?.turnId === "string" ? params.turnId.trim() : "";
          if (this.currentGoalRun && deltaTurnId) {
            const queue = this.currentGoalRun.pendingDeltasByTurnId.get(deltaTurnId) || [];
            queue.push({ delta, messageId });
            this.currentGoalRun.pendingDeltasByTurnId.set(deltaTurnId, queue);
          }
          return;
        }
        await this.emitWorkingStatus({
          phase: "message_aggregation",
          reply_in_progress: true,
          status_line: statusLineForPhase("message_aggregation"),
        });
        await this.queueAssistantDelta(delta, { messageId });
        return;
      }
      case "thread/tokenUsage/updated":
        this.tokenUsage = params?.tokenUsage && typeof params.tokenUsage === "object" ? { ...params.tokenUsage } : null;
        return;
      case "account/rateLimits/updated":
        this.rateLimits = params?.rateLimits && typeof params.rateLimits === "object" ? { ...params.rateLimits } : null;
        return;
      case "thread/goal/updated": {
        const goalPayload = this.normalizeGoalPayload(params?.goal ?? params);
        if (!goalPayload) {
          return;
        }
        this.currentGoal = goalPayload;
        const goalRun = this.currentGoalRun;
        if (goalRun && typeof goalRun.handleGoalUpdate === "function") {
          goalRun.handleGoalUpdate(goalPayload);
        }
        this.emit("goal_update", { ...goalPayload });
        return;
      }
      case "thread/goal/cleared": {
        const previous = this.currentGoal;
        this.currentGoal = null;
        const goalRun = this.currentGoalRun;
        if (goalRun && typeof goalRun.handleGoalCleared === "function") {
          goalRun.handleGoalCleared(previous);
        }
        this.emit("goal_cleared", previous ? { ...previous } : null);
        return;
      }
      case "turn/completed": {
        let currentTurn = this.ensureCurrentTurn(params);
        if (!currentTurn && this.currentTurn && !this.currentTurn.goalMode) {
          // Defense-in-depth (BUG-R6-01 class): a non-goal session has exactly
          // one active turn. If turn matching fails (missing `turn/started`, a
          // turnId mismatch, or an id carried on a different field), we must NOT
          // strand the terminal clear here — otherwise the composer stays on
          // "codex composing reply" until the 12-min idle deadline or a reload.
          currentTurn = this.currentTurn;
        }
        if (!currentTurn) {
          return;
        }
        await this.finalizeActiveAssistantMessage(currentTurn, {
          messageId: currentTurn.activeAssistantMessageId,
        });
        this.manualResumeReady = true;
        this.activeReplyTarget = "";
        const turn = params?.turn && typeof params.turn === "object" ? params.turn : {};
        const status = typeof turn.status === "string" ? turn.status.trim() : "";
        const turnError = turn?.error;
        if (status && status !== "completed") {
          const error = createTurnError(`Codex turn failed (${status})`, {
            reason: "turn_failed",
            turnStatus: status,
            turnError,
          });
          await this.emitTurnCompletedStatus(currentTurn, {
            phase: "turn_failed",
            status_done_line: `codex failed (${status})`,
          });
          if (currentTurn.goalMode) {
            // Propagate to the goal-run completion so callers see the failure.
            const goalRun = this.currentGoalRun;
            if (goalRun && typeof goalRun.handleTurnFailed === "function") {
              goalRun.handleTurnFailed(error);
            }
          } else {
            currentTurn.reject(error);
            this.currentTurn = null;
          }
          return;
        }
        // In goal mode, do NOT resolve/clear currentTurn on per-turn completion.
        // The goal may span multiple turns and resolves on a terminal
        // `thread/goal/updated` status (or `thread/goal/cleared`). The
        // per-turn text is folded into `currentGoalRun.fullText` so it
        // survives the per-turn reset.
        if (currentTurn.goalMode) {
          const goalRun = this.currentGoalRun;
          if (goalRun) {
            const turnText = currentTurn.fullText || "";
            if (turnText) {
              goalRun.fullText = `${goalRun.fullText || ""}${turnText}`;
              goalRun.lastTurnText = turnText;
            }
          }
          // Reset per-turn accumulator state but keep the goal-scoped turn alive
          // so subsequent `turn/started` / `item/*` events continue to be handled.
          currentTurn.turnId = "";
          currentTurn.fullText = "";
          currentTurn.activeAssistantMessageId = "";
          currentTurn.activeAssistantMessageText = "";
          return;
        }
        await this.emitTurnCompletedStatus(currentTurn);
        currentTurn.resolve({
          turn,
          usage: this.tokenUsage ? { ...this.tokenUsage } : null,
        });
        this.currentTurn = null;
        return;
      }
      default:
        return;
    }
  }

  handleTransportFailure(error) {
    if (this.currentGoalRun && typeof this.currentGoalRun.handleTurnFailed === "function") {
      try {
        this.currentGoalRun.handleTurnFailed(error);
      } catch {
        // best effort
      }
    }
    if (this.currentTurn) {
      this.currentTurn.reject(error);
      this.currentTurn = null;
    }
  }

  handleTransportExit(payload) {
    const exitError = createTurnError("Codex app-server exited", {
      reason: this.closeRequested ? "session_closed" : "transport_exited",
      code: payload?.code,
      signal: payload?.signal,
      stderr: payload?.stderr,
    });
    this.closed = true;
    // Reject in-flight goal-runs / per-turn callers with the precise
    // `transport_exited` error BEFORE we flip `closeRequested` / flush close
    // waiters. Otherwise the closeGuard would win the Promise.race and the
    // caller would see a generic `session_closed` instead of the real cause.
    this.handleTransportFailure(exitError);
    this.closeRequested = true;
    this.flushCloseWaiters();
    this.emit("process.exited", {
      pid: this.transport.pid || null,
      code: payload?.code,
      signal: payload?.signal,
      stderr: payload?.stderr,
    });
  }

  maybeEmitAuthRequired(error) {
    const message = String(error?.message || "").toLowerCase();
    if (!message.includes("unauthorized") && !message.includes("login")) {
      return;
    }
    this.emit("auth_required", {
      reason: "login_required",
      message: error.message,
    });
  }

  async interruptCurrentTurn() {
    const currentTurn = this.currentTurn;
    if (!currentTurn || !this.sessionId || !currentTurn.turnId) {
      return false;
    }
    try {
      await this.transport.request("turn/interrupt", {
        threadId: this.sessionId,
        turnId: currentTurn.turnId,
      });
      return true;
    } catch {
      // best effort
    }
    return false;
  }

  async runTurn(promptText, { useInitialImages = false, media: mediaInput, jsonSchema = null } = {}) {
    if (this.closeRequested) {
      throw this.createSessionClosedError();
    }

    const media = resolveTurnMedia(this.options, { useInitialImages, media: mediaInput });
    assertMediaCapabilities(media, this.backend, PROVIDER_MEDIA_CAPABILITIES[CODEX_APP_SERVER_VARIANT]);
    let effectivePrompt =
      this.buildPrompt(promptText, { useInitialImages: false }) ||
      (media.length ? defaultPromptForMedia(media) : "");
    if (jsonSchema && typeof jsonSchema === "object" && effectivePrompt) {
      effectivePrompt = injectJsonSchemaPrompt(effectivePrompt, jsonSchema);
    }
    if (!effectivePrompt) {
      return {
        text: "",
        usage: null,
        items: [],
        events: [],
      };
    }

    if (this.currentTurn) {
      throw createTurnError("Codex app-server turn already running", {
        reason: "turn_already_running",
      });
    }

    this.markTurnStartedStatus();
    try {
      await this.boot();
    } catch (error) {
      await this.failPendingTurnStart(error);
      throw error;
    }

    this.history.push({ role: "user", content: promptText });

    const closeGuard = this.createCloseGuard();
    const turnTimeoutGuard = this.createTurnTimeoutGuard();
    let resolveTurn = null;
    let rejectTurn = null;
    const completion = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const currentTurn = {
      turnId: "",
      fullText: "",
      activeAssistantMessageId: "",
      activeAssistantMessageText: "",
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.currentTurn = currentTurn;

    try {
      const startPromise = this.transport.request("turn/start", {
        threadId: this.sessionId,
        cwd: this.cwd,
        approvalPolicy: "never",
        input: buildCodexAppServerInput(effectivePrompt, media),
      });
      const turnResult = await Promise.race([
        (async () => {
          const requestResult = await startPromise;
          const completionResult = await completion;
          return {
            requestResult,
            completionResult,
          };
        })(),
        closeGuard.promise,
        turnTimeoutGuard.promise,
      ]);

      await this.finalizeActiveAssistantMessage(currentTurn, {
        messageId: currentTurn.activeAssistantMessageId,
      });

      // Belt-and-suspenders terminal clear. Idempotent (guarded on the turn),
      // so when the wire `turn/completed` already cleared this is a no-op; it
      // only fires if the turn resolved without the wire clear reaching here.
      await this.emitTurnCompletedStatus(currentTurn);

      if (currentTurn.fullText) {
        this.history.push({ role: "assistant", content: currentTurn.fullText });
      }

      return {
        text: currentTurn.fullText,
        usage: turnResult?.completionResult?.usage || null,
        items: Array.isArray(turnResult?.requestResult?.turn?.items) ? turnResult.requestResult.turn.items : [],
        events: [],
        provider: this.backend,
        metadata: {
          source: CODEX_APP_SERVER_VARIANT,
          threadId: this.sessionId,
          threadPath: this.threadPath || undefined,
          nativeSessionId: this.nativeSessionId || undefined,
        },
      };
    } catch (error) {
      if (error?.reason === "turn_timeout") {
        await this.interruptCurrentTurn();
      }
      if (!this.closeRequested && error?.reason !== "session_closed") {
        await this.emitWorkingStatus({
          phase: "turn_failed",
          reply_in_progress: false,
          status_done_line: error instanceof Error ? error.message : String(error),
        });
      }
      this.maybeEmitAuthRequired(error);
      throw error;
    } finally {
      if (this.currentTurn === currentTurn) {
        this.currentTurn = null;
      }
      closeGuard.cleanup();
      turnTimeoutGuard.cleanup();
    }
  }

  /**
   * Normalize a goal payload from a codex `thread/goal/*` notification into
   * the cross-layer {@link GoalState} shape.
   *
   * @param {unknown} payload
   * @returns {(import("../shared.js").GoalState & { raw?: unknown }) | null}
   */
  normalizeGoalPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const raw = /** @type {Record<string, unknown>} */ (payload);
    const objective =
      typeof raw.objective === "string"
        ? raw.objective
        : typeof raw.goal === "string"
          ? raw.goal
          : "";
    const status =
      typeof raw.status === "string" && raw.status.trim()
        ? /** @type {import("../shared.js").GoalStatus} */ (raw.status.trim())
        : "active";
    const id =
      typeof raw.id === "string"
        ? raw.id
        : typeof raw.goalId === "string"
          ? raw.goalId
          : undefined;
    const threadId =
      typeof raw.threadId === "string"
        ? raw.threadId
        : this.sessionId || undefined;
    const tokenBudget =
      raw.tokenBudget === null
        ? null
        : Number.isFinite(Number(raw.tokenBudget))
          ? Number(raw.tokenBudget)
          : undefined;
    return {
      id,
      threadId,
      objective,
      status,
      tokenBudget,
    };
  }

  /**
   * Trigger Codex's experimental `thread/goal/set` JSON-RPC. Requires the
   * app-server to have been booted with `--enable goals`; dynamic enablement
   * is NOT supported. Pass `{ goalMode: true }` to the session factory so the
   * transport spawns with the right flag.
   *
   * Resolves when the goal reaches a terminal status (`complete`, `blocked`,
   * `usageLimited`, `budgetLimited`) or when a `thread/goal/cleared`
   * notification arrives.
   *
   * @param {import("../shared.js").GoalRequest} goal
   * @param {object} [options]
   * @returns {Promise<import("../shared.js").GoalResult>}
   */
  async runGoal(goal, options = {}) {
    if (this.closeRequested) {
      throw this.createSessionClosedError();
    }
    const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
    if (!objective) {
      throw createTurnError("runGoal requires a non-empty objective", {
        reason: "invalid_goal",
      });
    }
    if (this.currentTurn || this.currentGoalRun) {
      throw createTurnError("Codex app-server turn already running", {
        reason: "turn_already_running",
      });
    }

    this.markTurnStartedStatus();
    try {
      await this.boot();
    } catch (error) {
      await this.failPendingTurnStart(error);
      throw error;
    }

    const tokenBudget =
      goal?.tokenBudget === null || Number.isFinite(Number(goal?.tokenBudget))
        ? goal.tokenBudget ?? null
        : null;

    const closeGuard = this.createCloseGuard();
    const turnTimeoutGuard = this.createTurnTimeoutGuard();

    let resolveGoal = null;
    let rejectGoal = null;
    const completion = new Promise((resolve, reject) => {
      resolveGoal = resolve;
      rejectGoal = reject;
    });

    // Goal-scoped state. Tracks accumulated text across multiple turns and
    // serves as the routing target for `thread/goal/*` notifications so that
    // goal lifecycle is decoupled from per-turn (`currentTurn`) lifecycle.
    const goalRun = {
      id: undefined,
      threadId: this.sessionId || undefined,
      objective,
      status: "active",
      tokenBudget,
      fullText: "",
      lastTurnText: "",
      latestGoal: null,
      completion,
      pendingDeltasByTurnId: new Map(),
      handleGoalUpdate: (payload) => {
        if (!payload) {
          return;
        }
        goalRun.latestGoal = { ...payload, objective: payload.objective || objective };
        goalRun.status = payload.status || goalRun.status;
        if (isTerminalGoalStatusLocal(payload.status)) {
          resolveGoal?.({
            goal: { ...goalRun.latestGoal },
            usage: this.tokenUsage ? { ...this.tokenUsage } : null,
            cleared: false,
          });
        }
      },
      handleGoalCleared: (previous) => {
        const finalGoal = goalRun.latestGoal || previous || {
          objective,
          status: "complete",
          threadId: this.sessionId || undefined,
          tokenBudget,
        };
        resolveGoal?.({
          goal: { ...finalGoal, status: finalGoal.status || "complete" },
          usage: this.tokenUsage ? { ...this.tokenUsage } : null,
          cleared: true,
        });
      },
      handleTurnFailed: (error) => {
        rejectGoal?.(error);
      },
    };
    this.currentGoalRun = goalRun;

    // `currentTurn` is still installed so that turn-scoped notification
    // handling (turn/started, item/started, item/agentMessage/delta, etc.)
    // continues to work. Its `resolve`/`reject` are stubs; goal completion
    // is signaled via the `completion` promise above.
    const currentTurn = {
      turnId: "",
      fullText: "",
      activeAssistantMessageId: "",
      activeAssistantMessageText: "",
      resolve: () => {},
      reject: (error) => {
        rejectGoal?.(error);
      },
      goalMode: true,
    };
    this.currentTurn = currentTurn;

    try {
      let setResult;
      try {
        setResult = await this.transport.request("thread/goal/set", {
          threadId: this.sessionId,
          objective,
          status: "active",
          tokenBudget,
        });
      } catch (error) {
        const message = String(error?.message || "");
        if (/goals?\s+feature\s+is\s+disabled/i.test(message) || /unsupported.*goal/i.test(message)) {
          const hint = new Error(
            `Codex goals feature is disabled. Re-create the session with { goalMode: true } so the app-server spawns with "--enable goals". (${message})`,
          );
          hint.reason = "goals_feature_disabled";
          hint.cause = error;
          throw hint;
        }
        throw error;
      }

      const initialGoalPayload =
        setResult && Object.prototype.hasOwnProperty.call(setResult, "goal")
          ? setResult.goal
          : setResult;
      const initialGoal = this.normalizeGoalPayload(initialGoalPayload);
      if (initialGoal) {
        this.currentGoal = initialGoal;
        goalRun.latestGoal = initialGoal;
        goalRun.id = initialGoal.id ?? goalRun.id;
        goalRun.threadId = initialGoal.threadId ?? goalRun.threadId;
        goalRun.status = initialGoal.status || goalRun.status;
        if (isTerminalGoalStatusLocal(initialGoal.status)) {
          resolveGoal?.({
            goal: { ...initialGoal },
            usage: this.tokenUsage ? { ...this.tokenUsage } : null,
            cleared: false,
          });
        }
      }

      const goalResult = await Promise.race([
        completion,
        closeGuard.promise,
        turnTimeoutGuard.promise,
      ]);

      // Fold any in-flight per-turn text into the goal's aggregate text.
      await this.finalizeActiveAssistantMessage(currentTurn, {
        messageId: currentTurn.activeAssistantMessageId,
      });
      if (currentTurn.fullText) {
        goalRun.fullText = `${goalRun.fullText || ""}${currentTurn.fullText}`;
      }

      const goalState = goalResult?.goal || {
        objective,
        status: "complete",
        threadId: this.sessionId || undefined,
        tokenBudget,
      };

      await this.emitWorkingStatus({
        phase: "turn_completed",
        reply_in_progress: false,
        status_done_line: `codex goal ${goalState.status}`,
      });

      if (goalRun.fullText) {
        this.history.push({ role: "assistant", content: goalRun.fullText });
      }

      return {
        text: goalRun.fullText,
        goal: {
          id: goalState.id,
          threadId: goalState.threadId || this.sessionId || undefined,
          objective: goalState.objective || objective,
          status: goalState.status,
          tokenBudget: goalState.tokenBudget !== undefined ? goalState.tokenBudget : tokenBudget,
        },
        usage: goalResult?.usage || (this.tokenUsage ? { ...this.tokenUsage } : null),
        metadata: {
          source: CODEX_APP_SERVER_VARIANT,
          threadId: this.sessionId,
          threadPath: this.threadPath || undefined,
          nativeSessionId: this.nativeSessionId || undefined,
          goalCleared: Boolean(goalResult?.cleared),
        },
      };
    } catch (error) {
      if (error?.reason === "turn_timeout") {
        await this.interruptCurrentTurn();
      }
      if (!this.closeRequested && error?.reason !== "session_closed") {
        await this.emitWorkingStatus({
          phase: "turn_failed",
          reply_in_progress: false,
          status_done_line: error instanceof Error ? error.message : String(error),
        });
      }
      this.maybeEmitAuthRequired(error);
      throw error;
    } finally {
      // Always clear goal-run state (NOT currentTurn — that's done by per-turn
      // lifecycle). currentTurn is also cleared here because the goal owns it.
      if (this.currentGoalRun === goalRun) {
        this.currentGoalRun = null;
      }
      if (this.currentTurn === currentTurn) {
        this.currentTurn = null;
      }
      closeGuard.cleanup();
      turnTimeoutGuard.cleanup();
    }
  }

  /**
   * Fetch the current goal via `thread/goal/get`.
   *
   * @returns {Promise<import("../shared.js").GoalState | null>}
   */
  async getGoal() {
    await this.boot();
    try {
      const result = await this.transport.request("thread/goal/get", {
        threadId: this.sessionId,
      });
      const hasGoalField = result && Object.prototype.hasOwnProperty.call(result, "goal");
      if (hasGoalField) {
        // Server explicitly told us about the goal (including null for
        // "no active goal"). Update in-memory state to match.
        const normalized = this.normalizeGoalPayload(result.goal);
        this.currentGoal = normalized;
        return normalized;
      }
      if (result === null || result === undefined) {
        // Transport hiccup (e.g. error mapped to a null result). Do NOT
        // wipe a previously known goal — return the cached state instead.
        return this.currentGoal ? { ...this.currentGoal } : null;
      }
      // Older codex builds returned the goal payload as the root result.
      const normalized = this.normalizeGoalPayload(result);
      if (normalized) {
        this.currentGoal = normalized;
      }
      return normalized;
    } catch (error) {
      const message = String(error?.message || "");
      if (/goals?\s+feature\s+is\s+disabled/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Clear the current goal via `thread/goal/clear`.
   *
   * If a {@link runGoal} call is in flight when this is invoked externally,
   * the pending `currentGoalRun.completion` is unblocked with a synthetic
   * "cleared" payload so the caller's `await runGoal(...)` resolves promptly
   * instead of waiting for the turn-timeout. The server-initiated
   * `thread/goal/clear` does not emit a `thread/goal/cleared` notification
   * (it's the response to OUR own RPC), so we have to wake the goal-run
   * ourselves here.
   *
   * @returns {Promise<boolean>} true if a goal was cleared, false if there was nothing to clear.
   */
  async clearGoal() {
    await this.boot();
    const goalRun = this.currentGoalRun;
    try {
      const result = await this.transport.request("thread/goal/clear", {
        threadId: this.sessionId,
      });
      const cleared =
        result === undefined || result === null
          ? Boolean(this.currentGoal)
          : result?.cleared !== false;
      const previous = this.currentGoal;
      this.currentGoal = null;
      if (goalRun && typeof goalRun.handleGoalCleared === "function") {
        try {
          goalRun.handleGoalCleared(previous);
        } catch {
          // best effort — never let the wake-up throw past clearGoal
        }
      }
      return cleared;
    } catch (error) {
      const message = String(error?.message || "");
      if (/no\s+goal/i.test(message) || /not\s+set/i.test(message)) {
        return false;
      }
      throw error;
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closeRequested = true;
    this.flushCloseWaiters();
    if (this.currentTurn) {
      await this.interruptCurrentTurn();
    }
    await this.transport.close();
    this.closed = true;
  }
}
