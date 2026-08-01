import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { KIMI_CLI_WIRE_VARIANT as KIMI_PROVIDER_VARIANT } from "../built-in-backends.js";
import { appendContextFilesToPrompt } from "../context-files.js";
import { PROVIDER_MEDIA_CAPABILITIES, buildKimiContent } from "../media-adapters.js";
import {
  assertMediaCapabilities,
  defaultPromptForMedia,
  resolveTurnMedia,
} from "../media-input.js";
import { KimiWireTransport } from "../transports/kimi-wire-transport.js";
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
const DEFAULT_STATUS_DEDUPE_MS = 120;
const DEFAULT_STATUS_THROTTLE_MS = 450;
const DEFAULT_REASONING_STATUS_THROTTLE_MS = 2500;
const DEFAULT_STATUS_PREVIEW_DELTA_CHARS = 24;
const MAX_STATUS_TIMING_MS = 10 * 1000;
const THINK_STATUS_LINE_MAX_CHARS = 120;
const THINK_TAIL_BUFFER_CHARS = 400;

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

function normalizeKimiBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "kimi-cli" || normalized === "kimi-code") {
    return "kimi";
  }
  return normalized || "kimi";
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function sanitizeSummary(value, maxLen = 180) {
  return sanitizeForLog(value, maxLen);
}

function normalizeContextUsagePercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const bounded = Math.min(Math.max(parsed, 0), 1);
  return Number((bounded * 100).toFixed(1));
}

function toolPhaseForName(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized) {
    return "tool_call";
  }
  if (normalized.includes("shell") || normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("replace") ||
    normalized.includes("patch")
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
  if (normalized.includes("web") || normalized.includes("search") || normalized.includes("fetch")) {
    return "web_lookup";
  }
  if (normalized.includes("task") || normalized.includes("subagent")) {
    return "task_progress";
  }
  return "tool_call";
}

function statusLineForPhase(phase, toolName = "") {
  switch (phase) {
    case "turn_started":
      return "Kimi is working on it";
    case "reasoning":
      return "Kimi is thinking";
    case "planning":
      return "Kimi is planning the next steps";
    case "command_execution":
      return toolName ? `Kimi is running ${toolName}` : "Kimi is running a command";
    case "file_update":
      return toolName ? `Kimi is editing files with ${toolName}` : "Kimi is editing files";
    case "workspace_inspection":
      return toolName ? `Kimi is reading files with ${toolName}` : "Kimi is reading the workspace";
    case "web_lookup":
      return toolName ? `Kimi is browsing with ${toolName}` : "Kimi is browsing the web";
    case "task_progress":
      return toolName ? `Kimi is coordinating ${toolName}` : "Kimi is working on sub-tasks";
    case "context_compaction":
      return "Kimi is compacting context";
    case "message_aggregation":
      return "Kimi is writing the reply";
    case "tool_call":
      return toolName ? `Kimi is calling ${toolName}` : "Kimi is calling a tool";
    default:
      return "Kimi is working";
  }
}

function buildEmptyTurnResult() {
  return {
    text: "",
    usage: null,
    items: [],
    events: [],
  };
}

function injectJsonSchemaPrompt(promptText, jsonSchema) {
  const schemaText = typeof jsonSchema === "string" ? jsonSchema : JSON.stringify(jsonSchema, null, 2);
  return `You must respond with valid JSON that strictly conforms to the following JSON Schema. Do not include any markdown formatting or explanation outside the JSON object.

JSON Schema:
${schemaText}

${promptText}`;
}

export class KimiCliSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = normalizeKimiBackend(backend);
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    this.resumeSessionId = typeof options.resumeSessionId === "string" ? options.resumeSessionId.trim() : "";
    this.sessionId = this.resumeSessionId || randomUUID();
    this.sessionInfo = {
      backend: this.backend,
      sessionId: this.sessionId,
    };
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
    this.lastTokenUsage = null;
    this.lastContextUsagePercent = undefined;
    this.currentTurnStatus = null;
    this.currentTurnActivityAt = 0;
    this.turnDeadlineMs = getBoundedEnvInt(
      "CONDUCTOR_TURN_DEADLINE_MS",
      DEFAULT_TURN_DEADLINE_MS,
      MIN_TURN_DEADLINE_MS,
      MAX_TURN_DEADLINE_MS,
    );
    this.workingStatusDedupeMs = getBoundedEnvInt(
      "CONDUCTOR_KIMI_STATUS_DEDUPE_MS",
      DEFAULT_STATUS_DEDUPE_MS,
      0,
      MAX_STATUS_TIMING_MS,
    );
    this.workingStatusThrottleMs = getBoundedEnvInt(
      "CONDUCTOR_KIMI_STATUS_THROTTLE_MS",
      DEFAULT_STATUS_THROTTLE_MS,
      0,
      MAX_STATUS_TIMING_MS,
    );
    this.reasoningStatusThrottleMs = getBoundedEnvInt(
      "CONDUCTOR_KIMI_REASONING_STATUS_THROTTLE_MS",
      DEFAULT_REASONING_STATUS_THROTTLE_MS,
      0,
      MAX_STATUS_TIMING_MS,
    );
    this.workingStatusPreviewDeltaChars = getBoundedEnvInt(
      "CONDUCTOR_KIMI_STATUS_PREVIEW_DELTA_CHARS",
      DEFAULT_STATUS_PREVIEW_DELTA_CHARS,
      1,
      500,
    );
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.lastWorkingStatusEmission = null;
    this.bootPromise = null;
    this.booted = false;
    this.sessionAnnounced = false;

    const envConfig = loadEnvConfig(options.configFile);
    const proxyEnv = proxyToEnv(envConfig);
    const extraEnv = envConfig && typeof envConfig === "object" ? { ...envConfig, ...proxyEnv } : proxyEnv;
    this.env = {
      ...extraEnv,
      ...(options.env && typeof options.env === "object" ? options.env : {}),
    };

    this.transport = options.transport || new KimiWireTransport({
      cwd: this.cwd,
      env: this.env,
      logger: {
        log: (message) => {
          this.writeLog(message);
        },
      },
      commandLine: options.commandLine,
      sessionId: this.sessionId,
      model: typeof options.model === "string" ? options.model.trim() : "",
    });
    this.transport.on("event", ({ type, payload }) => {
      void this.handleWireEvent(type, payload);
    });
    this.transport.on("request", ({ id, type, payload }) => {
      void this.handleWireRequest(id, type, payload);
    });
    this.transport.on("process_exit", (payload) => {
      this.handleTransportExit(payload);
    });
    this.transport.on("process_error", (payload) => {
      const error = createTurnError(payload?.message || "Kimi wire transport error", payload || {});
      this.handleTransportFailure(error);
    });
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [kimi-cli] ${message}`);
  }

  get threadId() {
    return this.sessionId;
  }

  get threadOptions() {
    const model =
      typeof this.options.model === "string" && this.options.model.trim()
        ? this.options.model.trim()
        : this.backend;
    return { model };
  }

  buildManualResumeCommand() {
    if (!this.sessionId) {
      return "";
    }
    if (this.transport && typeof this.transport.buildResumeCommandLine === "function") {
      return this.transport.buildResumeCommandLine();
    }
    return `kimi --work-dir ${this.cwd} --session ${this.sessionId}`;
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: KIMI_PROVIDER_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId || undefined,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: Boolean(this.sessionId),
      manualResume: this.sessionId
        ? {
            ready: true,
            command: this.buildManualResumeCommand(),
          }
        : null,
      currentTurnStatus: this.getCurrentTurnStatus(),
      capabilities: { media: PROVIDER_MEDIA_CAPABILITIES[KIMI_PROVIDER_VARIANT] },
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
      sessionFilePath: undefined,
      tokenUsagePercent: undefined,
      contextUsagePercent: this.lastContextUsagePercent,
      tokenUsage: this.lastTokenUsage ? { ...this.lastTokenUsage } : null,
      rateLimits: null,
      manualResume: this.sessionId
        ? {
            ready: true,
            command: this.buildManualResumeCommand(),
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
      source: KIMI_PROVIDER_VARIANT,
      reply_in_progress: true,
      replyTo: this.getCurrentReplyTarget(),
      phase: "turn_started",
      status_line: statusLineForPhase("turn_started"),
      thread_id: this.sessionId || undefined,
      session_id: this.sessionId || undefined,
      session_file_path: undefined,
    });
  }

  async failPendingTurnStart(error, onProgress = null) {
    if (this.closeRequested || error?.reason === "session_closed") {
      return;
    }
    await this.emitWorkingStatus(
      {
        phase: "turn_failed",
        reply_in_progress: false,
        status_done_line: error instanceof Error ? error.message : String(error),
      },
      onProgress,
    );
  }

  buildWorkingStatusFingerprint(payload) {
    return JSON.stringify({
      reply_in_progress: Boolean(payload?.reply_in_progress),
      phase: payload?.phase || "",
      status_line: payload?.status_line || "",
      status_done_line: payload?.status_done_line || "",
      reply_preview: payload?.reply_preview || "",
      replyTo: payload?.replyTo || "",
    });
  }

  shouldSuppressWorkingStatus(payload) {
    const previous = this.lastWorkingStatusEmission;
    if (!previous) {
      return false;
    }

    const now = this.now();
    const sameFingerprint = previous.fingerprint === this.buildWorkingStatusFingerprint(payload);
    const elapsedMs = now - previous.emittedAt;
    if (sameFingerprint && elapsedMs >= 0 && elapsedMs < this.workingStatusDedupeMs) {
      return true;
    }

    if (!payload?.reply_in_progress || !previous.payload?.reply_in_progress) {
      return false;
    }

    const samePhaseAndLine =
      String(previous.payload?.phase || "") === String(payload?.phase || "") &&
      String(previous.payload?.status_line || "") === String(payload?.status_line || "");
    const throttleMs =
      payload?.phase === "reasoning" || payload?.phase === "planning"
        ? this.reasoningStatusThrottleMs
        : this.workingStatusThrottleMs;
    if (!samePhaseAndLine || elapsedMs < 0 || elapsedMs >= throttleMs) {
      return false;
    }
    if (payload?.status_done_line) {
      return false;
    }

    if (payload?.phase !== "message_aggregation") {
      return true;
    }

    const previousPreview = normalizeText(previous.payload?.reply_preview);
    const nextPreview = normalizeText(payload?.reply_preview);
    if (!nextPreview) {
      return true;
    }
    if (!previousPreview) {
      return false;
    }

    return nextPreview.length < previousPreview.length + this.workingStatusPreviewDeltaChars;
  }

  recordWorkingStatusEmission(payload) {
    this.lastWorkingStatusEmission = {
      fingerprint: this.buildWorkingStatusFingerprint(payload),
      emittedAt: this.now(),
      payload: {
        reply_in_progress: Boolean(payload?.reply_in_progress),
        phase: payload?.phase,
        status_line: payload?.status_line,
        status_done_line: payload?.status_done_line,
        reply_preview: payload?.reply_preview,
        replyTo: payload?.replyTo,
      },
    };
  }

  async emitWorkingStatus(payload, onProgress = null) {
    const normalized = {
      source: KIMI_PROVIDER_VARIANT,
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
    if (this.shouldSuppressWorkingStatus(normalized)) {
      this.updateCurrentTurnStatus(normalized);
      return;
    }
    this.updateCurrentTurnStatus(normalized);
    const snapshot = this.getCurrentTurnStatus();
    this.recordWorkingStatusEmission(normalized);
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
      source: KIMI_PROVIDER_VARIANT,
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
    const error = new Error("Kimi session closed");
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
    if (!this.sessionAnnounced) {
      this.sessionAnnounced = true;
      this.trace(`session ready id=${this.sessionId}`);
      this.emit("session", this.getSessionInfo());
    }
  }

  updateUsageFromStatus(payload) {
    this.lastContextUsagePercent = normalizeContextUsagePercent(payload?.context_usage);
    this.lastTokenUsage = payload?.token_usage && typeof payload.token_usage === "object"
      ? { ...payload.token_usage }
      : this.lastTokenUsage;
  }

  appendAssistantText(currentTurn, text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return;
    }
    currentTurn.bufferedAssistantText += normalized;
  }

  appendThinkText(currentTurn, text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return;
    }
    currentTurn.thinkText = `${currentTurn.thinkText}${normalized}`.slice(-THINK_TAIL_BUFFER_CHARS);
  }

  thinkStatusLine(currentTurn) {
    const now = this.now();
    if (
      currentTurn.thinkStatusLine &&
      now - currentTurn.thinkStatusLineAt < this.reasoningStatusThrottleMs
    ) {
      return currentTurn.thinkStatusLine;
    }
    const sanitized = sanitizeSummary(currentTurn.thinkText, THINK_TAIL_BUFFER_CHARS);
    const snippet =
      sanitized.length > THINK_STATUS_LINE_MAX_CHARS
        ? `…${sanitized.slice(-THINK_STATUS_LINE_MAX_CHARS)}`
        : sanitized;
    if (snippet && snippet !== currentTurn.thinkStatusLine) {
      currentTurn.thinkStatusLine = snippet;
      currentTurn.thinkStatusLineAt = now;
    }
    return currentTurn.thinkStatusLine || statusLineForPhase("reasoning");
  }

  async finalizeAssistantMessage(currentTurn) {
    if (!currentTurn) {
      return false;
    }
    const text = currentTurn.bufferedAssistantText;
    if (!text) {
      return false;
    }
    currentTurn.fullText += text;
    currentTurn.bufferedAssistantText = "";
    await this.emitAssistantMessage(text);
    return true;
  }

  maybeEmitAuthRequired(error) {
    const message = String(error?.message || "").toLowerCase();
    if (
      !message.includes("login") &&
      !message.includes("auth") &&
      !message.includes("credential") &&
      !message.includes("api key") &&
      !message.includes("llm is not set") &&
      !message.includes("not configured")
    ) {
      return;
    }
    this.emit("auth_required", {
      reason: "login_required",
      message: error?.message || "Kimi authentication required",
    });
  }

  async failUnexpectedInteractiveRequest(id, requestType, payload) {
    const currentTurn = this.currentTurn;
    const summary =
      sanitizeSummary(payload?.description || payload?.action || payload?.name || requestType, 160) || requestType;

    const error = createTurnError(
      `Kimi CLI requested interactive input in unattended Conductor mode (${requestType})`,
      {
        reason: "unexpected_interactive_request",
        requestType,
        requestSummary: summary,
      },
    );
    this.handleTransportFailure(error);

    if (currentTurn) {
      await this.emitWorkingStatus(
        {
          phase: "tool_call",
          reply_in_progress: true,
          status_line: summary,
        },
        currentTurn.onProgress,
      );
    }

    if (requestType === "ApprovalRequest") {
      this.transport.sendResponse(id, {
        request_id: payload?.id || "",
        response: "reject",
      });
    } else if (requestType === "QuestionRequest") {
      this.transport.sendResponse(id, {
        request_id: payload?.id || "",
        answers: {},
      });
    } else if (requestType === "ToolCallRequest") {
      this.transport.sendResponse(id, {
        tool_call_id: payload?.id || "",
        return_value: {
          is_error: true,
          output: "",
          message: "External tool calls are not supported in unattended Conductor mode",
          display: [],
        },
      });
    } else {
      this.transport.sendError(id, {
        code: -32603,
        message: "Unsupported interactive request",
      });
    }

    void this.interruptCurrentTurn();
  }

  async handleWireRequest(id, type, payload) {
    await this.failUnexpectedInteractiveRequest(id, normalizeText(type), payload && typeof payload === "object" ? payload : {});
  }

  async handleWireEvent(type, payload) {
    const normalizedType = normalizeText(type);
    const normalizedPayload = payload && typeof payload === "object" ? payload : {};
    const currentTurn = this.currentTurn;

    if (currentTurn) {
      currentTurn.items.push({
        type: normalizedType,
        payload: normalizedPayload,
      });
    }

    if (!currentTurn) {
      if (normalizedType === "StatusUpdate") {
        this.updateUsageFromStatus(normalizedPayload);
      }
      return;
    }

    switch (normalizedType) {
      case "TurnBegin":
        await this.emitWorkingStatus(
          {
            phase: "turn_started",
            reply_in_progress: true,
            status_line: statusLineForPhase("turn_started"),
          },
          currentTurn.onProgress,
        );
        return;
      case "TurnEnd":
        currentTurn.seenTurnEnd = true;
        if (currentTurn.bufferedAssistantText) {
          await this.finalizeAssistantMessage(currentTurn);
        }
        // Clear reply_in_progress as soon as the wire reports the turn ended,
        // decoupled from the `prompt` JSON-RPC promise. Without this, a delayed
        // or dropped prompt RPC response leaves the web UI pinned on
        // "Kimi is writing the reply" until reload. emitTerminalWorkingStatus is
        // idempotent, so the later runTurn call becomes a harmless no-op.
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_completed",
            status_done_line: "Kimi finished",
          },
          currentTurn.onProgress,
        );
        return;
      case "StepBegin":
        if (currentTurn.bufferedAssistantText) {
          await this.finalizeAssistantMessage(currentTurn);
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
      case "CompactionBegin":
        await this.emitWorkingStatus(
          {
            phase: "context_compaction",
            reply_in_progress: true,
            status_line: statusLineForPhase("context_compaction"),
          },
          currentTurn.onProgress,
        );
        return;
      case "StatusUpdate":
        this.updateUsageFromStatus(normalizedPayload);
        if (normalizedPayload.plan_mode === true) {
          await this.emitWorkingStatus(
            {
              phase: "planning",
              reply_in_progress: true,
              status_line: statusLineForPhase("planning"),
            },
            currentTurn.onProgress,
          );
        }
        return;
      case "ContentPart":
        if (normalizedPayload.type === "think") {
          this.appendThinkText(currentTurn, normalizedPayload.think);
          await this.emitWorkingStatus(
            {
              phase: "reasoning",
              reply_in_progress: true,
              status_line: this.thinkStatusLine(currentTurn),
            },
            currentTurn.onProgress,
          );
          return;
        }
        if (normalizedPayload.type === "text") {
          this.appendAssistantText(currentTurn, normalizedPayload.text);
          await this.emitWorkingStatus(
            {
              phase: "message_aggregation",
              reply_in_progress: true,
              status_line: statusLineForPhase("message_aggregation"),
              reply_preview: sanitizeSummary(currentTurn.bufferedAssistantText, 120),
            },
            currentTurn.onProgress,
          );
        }
        return;
      case "ToolCall": {
        const toolName = normalizeText(normalizedPayload?.function?.name);
        const toolId = normalizeText(normalizedPayload?.id);
        if (toolId) {
          currentTurn.toolCalls.set(toolId, toolName);
        }
        const phase = toolPhaseForName(toolName);
        await this.emitWorkingStatus(
          {
            phase,
            reply_in_progress: true,
            status_line: statusLineForPhase(phase, toolName),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "ToolResult": {
        const toolId = normalizeText(normalizedPayload.tool_call_id);
        const toolName = currentTurn.toolCalls.get(toolId) || "";
        const phase = toolPhaseForName(toolName);
        const statusDoneLine =
          sanitizeSummary(normalizedPayload?.return_value?.message || normalizedPayload?.return_value?.output, 160) || undefined;
        await this.emitWorkingStatus(
          {
            phase,
            reply_in_progress: true,
            status_line: statusLineForPhase(phase, toolName),
            status_done_line: statusDoneLine,
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "SubagentEvent":
        await this.emitWorkingStatus(
          {
            phase: "task_progress",
            reply_in_progress: true,
            status_line: statusLineForPhase("task_progress"),
          },
          currentTurn.onProgress,
        );
        return;
      default:
        return;
    }
  }

  handleTransportFailure(error) {
    const currentTurn = this.currentTurn;
    if (!currentTurn || currentTurn.settled) {
      return;
    }
    currentTurn.settled = true;
    currentTurn.reject(error);
  }

  handleTransportExit(payload) {
    const stderrSummary = Array.isArray(payload?.stderr)
      ? sanitizeSummary(payload.stderr.filter(Boolean).at(-1), 200)
      : "";
    const exitError = createTurnError(stderrSummary ? `Kimi CLI exited: ${stderrSummary}` : "Kimi CLI exited", {
      reason: this.closeRequested ? "session_closed" : "transport_exited",
      code: payload?.code,
      signal: payload?.signal,
      stderr: payload?.stderr,
    });
    this.closed = true;
    if (this.closeRequested) {
      this.flushCloseWaiters();
    }
    this.handleTransportFailure(exitError);
    this.emit("process.exited", {
      pid: this.transport.pid || null,
      code: payload?.code,
      signal: payload?.signal,
      stderr: payload?.stderr,
    });
  }

  async interruptCurrentTurn() {
    if (!this.currentTurn) {
      return false;
    }
    try {
      await this.transport.request("cancel", {});
      return true;
    } catch {
      // best effort
    }
    return false;
  }

  async runTurn(promptText, { useInitialImages = false, media: mediaInput, contextFiles, onProgress = null, jsonSchema = null } = {}) {
    if (this.closeRequested || this.closed) {
      throw this.createSessionClosedError();
    }

    const media = resolveTurnMedia(this.options, { useInitialImages, media: mediaInput });
    assertMediaCapabilities(media, this.backend, PROVIDER_MEDIA_CAPABILITIES[KIMI_PROVIDER_VARIANT]);
    let effectivePrompt =
      this.buildPrompt(promptText, { useInitialImages: false }) ||
      (media.length ? defaultPromptForMedia(media) : "");
    effectivePrompt = appendContextFilesToPrompt(effectivePrompt, contextFiles).prompt;
    if (jsonSchema && typeof jsonSchema === "object" && effectivePrompt) {
      effectivePrompt = injectJsonSchemaPrompt(effectivePrompt, jsonSchema);
    }
    if (!effectivePrompt) {
      return buildEmptyTurnResult();
    }

    if (this.currentTurn) {
      throw createTurnError("Kimi turn already running", {
        reason: "turn_already_running",
      });
    }

    this.markTurnStartedStatus();
    try {
      await this.boot();
    } catch (error) {
      await this.failPendingTurnStart(error, onProgress);
      throw error;
    }

    this.history.push({ role: "user", content: promptText });

    const currentTurn = {
      fullText: "",
      bufferedAssistantText: "",
      thinkText: "",
      thinkStatusLine: "",
      thinkStatusLineAt: 0,
      items: [],
      toolCalls: new Map(),
      onProgress,
      reject: null,
      settled: false,
      terminalWorkingStatusEmitted: false,
      seenTurnEnd: false,
    };
    const turnFailurePromise = new Promise((_, reject) => {
      currentTurn.reject = reject;
    });
    this.currentTurn = currentTurn;

    const closeGuard = this.createCloseGuard(() => {
      void this.interruptCurrentTurn();
    });
    const turnTimeoutGuard = this.createTurnTimeoutGuard(() => {
      void this.interruptCurrentTurn();
    });

    try {
      await this.emitWorkingStatus(
        {
          phase: "turn_started",
          reply_in_progress: true,
          status_line: statusLineForPhase("turn_started"),
        },
        onProgress,
      );

      const promptResult = await Promise.race([
        this.transport.request("prompt", {
          user_input:
            media.length === 0
              ? effectivePrompt
              : buildKimiContent(effectivePrompt, media),
        }),
        turnFailurePromise,
        closeGuard.promise,
        turnTimeoutGuard.promise,
      ]);

      currentTurn.settled = true;
      await this.finalizeAssistantMessage(currentTurn);

      if (currentTurn.fullText) {
        this.history.push({ role: "assistant", content: currentTurn.fullText });
      }

      const normalizedStatus = normalizeText(promptResult?.status);
      if (normalizedStatus === "cancelled") {
        throw createTurnError("Kimi turn cancelled", {
          reason: "turn_cancelled",
        });
      }

      const statusDoneLine =
        normalizedStatus === "max_steps_reached"
          ? "Kimi reached the step limit"
          : "Kimi finished";

      await this.emitTerminalWorkingStatus(
        currentTurn,
        {
          phase: normalizedStatus === "max_steps_reached" ? "turn_completed" : "turn_completed",
          status_done_line: statusDoneLine,
        },
        onProgress,
      );

      this.activeReplyTarget = "";

      return {
        text: currentTurn.fullText,
        usage: this.lastTokenUsage ? { ...this.lastTokenUsage } : null,
        items: currentTurn.items,
        events: currentTurn.items,
        provider: this.backend,
        metadata: {
          source: KIMI_PROVIDER_VARIANT,
          sessionId: this.sessionId || undefined,
          promptStatus: normalizedStatus || undefined,
          contextUsagePercent: this.lastContextUsagePercent,
        },
      };
    } catch (error) {
      if (error?.reason === "turn_timeout") {
        await this.interruptCurrentTurn();
      }
      if (!this.closeRequested && error?.reason !== "session_closed") {
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_failed",
            status_done_line: String(error?.message || error || "Kimi turn failed"),
          },
          onProgress,
        );
      }
      if (this.closeRequested && error?.reason !== "session_closed") {
        throw this.createSessionClosedError();
      }
      this.maybeEmitAuthRequired(error);
      throw error;
    } finally {
      this.activeReplyTarget = "";
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
