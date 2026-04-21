import { EventEmitter } from "node:events";

import { CodexAppServerTransport } from "../transports/codex-app-server-transport.js";
import {
  emitLog,
  getBoundedEnvInt,
  loadEnvConfig,
  normalizeLogger,
  proxyToEnv,
  sanitizeForLog,
} from "../shared.js";

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

function buildTurnInput(promptText) {
  return [
    {
      type: "text",
      text: promptText,
    },
  ];
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

    const envConfig = loadEnvConfig(options.configFile);
    const proxyEnv = proxyToEnv(envConfig);
    const extraEnv = envConfig && typeof envConfig === "object" ? { ...envConfig, ...proxyEnv } : proxyEnv;
    this.transport = new CodexAppServerTransport({
      cwd: this.cwd,
      env: extraEnv,
      logger: {
        log: (message) => {
          this.writeLog(message);
        },
      },
      commandLine: options.commandLine,
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
      provider: "codex-app-server",
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
      source: "codex-app-server",
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
      source: "codex-app-server",
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

  async emitAssistantMessage(text) {
    this.touchTurnActivity();
    const payload = {
      text,
      preserveWhitespace: true,
      source: "codex-app-server",
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
    if (turnId && currentTurn.turnId && currentTurn.turnId !== turnId) {
      return null;
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
        const currentTurn = this.ensureCurrentTurn(params);
        if (!currentTurn) {
          return;
        }
        const delta = typeof params?.delta === "string" ? params.delta : "";
        const messageId = normalizeItemId(params?.itemId || params?.item_id);
        if (!delta) {
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
      case "turn/completed": {
        const currentTurn = this.ensureCurrentTurn(params);
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
          await this.emitWorkingStatus({
            phase: "turn_failed",
            reply_in_progress: false,
            status_done_line: `codex failed (${status})`,
          });
          currentTurn.reject(error);
          this.currentTurn = null;
          return;
        }
        await this.emitWorkingStatus({
          phase: "turn_completed",
          reply_in_progress: false,
          status_done_line: "codex finished",
        });
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
    this.closeRequested = true;
    this.flushCloseWaiters();
    this.handleTransportFailure(exitError);
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

  async runTurn(promptText, { useInitialImages = false } = {}) {
    if (this.closeRequested) {
      throw this.createSessionClosedError();
    }

    const effectivePrompt = this.buildPrompt(promptText, { useInitialImages });
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
        input: buildTurnInput(effectivePrompt),
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
          source: "codex-app-server",
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
