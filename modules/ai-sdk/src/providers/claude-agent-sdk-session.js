import { EventEmitter } from "node:events";

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
const DEFAULT_SETTING_SOURCES = ["user", "project", "local"];
const CLAUDE_PROVIDER_VARIANT = "claude-agent-sdk";

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
  switch (normalized) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return normalized;
    default:
      return "bypassPermissions";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function extractAssistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
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
  constructor(backend, options = {}) {
    super();
    this.backend = normalizeClaudeBackend(backend);
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
    };
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  getCurrentTurnStatus() {
    return this.currentTurnStatus ? { ...this.currentTurnStatus } : null;
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
    const permissionMode = normalizePermissionMode(this.options.permissionMode);
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

    if (permissionMode === "bypassPermissions" || this.options.allowDangerouslySkipPermissions === true) {
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
        const text = extractAssistantText(message.message);
        if (!text) {
          return;
        }
        currentTurn.emittedAssistantMessage = true;
        currentTurn.fullText = text;
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
        return;
      default:
        return;
    }
  }

  async interruptCurrentTurn() {
    const currentTurn = this.currentTurn;
    if (!currentTurn) {
      return;
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
  }

  async runTurn(promptText, { useInitialImages = false, onProgress = null, jsonSchema = null } = {}) {
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
      throw createTurnError("Claude Agent SDK turn already running", {
        reason: "turn_already_running",
      });
    }

    const sdkModule = await this.getSdkModule();
    if (!sdkModule || typeof sdkModule.query !== "function") {
      throw new Error("Claude Agent SDK is unavailable");
    }

    this.history.push({ role: "user", content: promptText });

    const abortController = new AbortController();
    const currentTurn = {
      abortController,
      emittedAssistantMessage: false,
      fullText: "",
      items: [],
      query: null,
      resultMessage: null,
      terminalWorkingStatusEmitted: false,
    };
    this.currentTurn = currentTurn;
    this.markTurnStartedStatus();

    const closeGuard = this.createCloseGuard(() => {
      abortController.abort();
      currentTurn.query?.close?.();
    });
    const turnTimeoutGuard = this.createTurnTimeoutGuard(() => {
      abortController.abort();
      currentTurn.query?.close?.();
    });

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

      const query = sdkModule.query({
        prompt: effectivePrompt,
        options: this.buildSdkOptions(abortController),
      });
      currentTurn.query = query;

      const resultMessage = await Promise.race([
        (async () => {
          for await (const message of query) {
            await this.handleSdkMessage(message, currentTurn, { onProgress });
          }
          return currentTurn.resultMessage;
        })(),
        closeGuard.promise,
        turnTimeoutGuard.promise,
      ]);

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

      if (!currentTurn.emittedAssistantMessage && responseText) {
        await this.emitAssistantMessage(responseText);
      }

      if (responseText) {
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
        usage: resultMessage.usage ? { ...resultMessage.usage } : null,
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
      };
    } catch (error) {
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
        throw this.createSessionClosedError();
      }
      this.maybeEmitAuthRequired(error?.message || "", error?.message || "");
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
      try {
        currentTurn.query?.close?.();
      } catch {
        // best effort
      }
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closeRequested = true;
    this.flushCloseWaiters();
    await this.interruptCurrentTurn();
    this.closed = true;
  }
}
