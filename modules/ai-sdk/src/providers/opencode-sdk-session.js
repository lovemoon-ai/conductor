import { EventEmitter } from "node:events";

import { OpencodeServerTransport } from "../transports/opencode-server-transport.js";
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
const OPENCODE_PROVIDER_VARIANT = "opencode-sdk";

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

function normalizeOpencodeBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "open-code" || normalized === "open_code") {
    return "opencode";
  }
  return normalized || "opencode";
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function sanitizeSummary(value, maxLen = 180) {
  return sanitizeForLog(value, maxLen);
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
    case "context_compaction":
      return "opencode compacting context";
    case "reasoning":
      return "opencode reasoning";
    case "planning":
      return "opencode updating plan";
    case "command_execution":
      return toolName ? `opencode running ${toolName}` : "opencode running command";
    case "file_update":
      return toolName ? `opencode editing with ${toolName}` : "opencode editing files";
    case "workspace_inspection":
      return toolName ? `opencode reading with ${toolName}` : "opencode reading workspace";
    case "web_lookup":
      return toolName ? `opencode browsing with ${toolName}` : "opencode browsing";
    case "task_progress":
      return detail || (toolName ? `opencode running ${toolName}` : "opencode running task");
    case "message_aggregation":
      return "opencode composing reply";
    case "tool_call":
      return detail || (toolName ? `opencode calling ${toolName}` : "opencode calling tool");
    default:
      return "opencode is working";
  }
}

function isTruthyPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function buildOpencodeConfig(options = {}) {
  const userConfig = isTruthyPlainObject(options.opencodeConfig) ? { ...options.opencodeConfig } : {};
  if (userConfig.permission === undefined) {
    userConfig.permission = "allow";
  }
  if (userConfig.share === undefined) {
    userConfig.share = "disabled";
  }
  if (typeof options.model === "string" && options.model.trim() && userConfig.model === undefined) {
    userConfig.model = options.model.trim();
  }
  if (typeof options.agent === "string" && options.agent.trim() && userConfig.default_agent === undefined) {
    userConfig.default_agent = options.agent.trim();
  }
  return userConfig;
}

function buildEmptyTurnResult() {
  return {
    text: "",
    usage: null,
    items: [],
    events: [],
  };
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function extractErrorMessage(error) {
  if (!error) {
    return "Opencode turn failed";
  }
  if (typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Opencode turn failed";
}

export class OpencodeSdkSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = normalizeOpencodeBackend(backend);
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
    this.currentTurn = null;
    this.lastUsage = null;
    this.lastAssistantInfo = null;
    this.turnDeadlineMs = getBoundedEnvInt(
      "CONDUCTOR_TURN_DEADLINE_MS",
      DEFAULT_TURN_DEADLINE_MS,
      MIN_TURN_DEADLINE_MS,
      MAX_TURN_DEADLINE_MS,
    );
    this.client = null;
    this.sdkModulePromise = null;
    this.bootPromise = null;
    this.booted = false;
    this.eventStreamAbortController = null;
    this.eventStreamPromise = null;

    const envConfig = loadEnvConfig(options.configFile);
    const proxyEnv = proxyToEnv(envConfig);
    const extraEnv = envConfig && typeof envConfig === "object" ? { ...envConfig, ...proxyEnv } : proxyEnv;
    this.env = {
      ...extraEnv,
      ...(options.env && typeof options.env === "object" ? options.env : {}),
    };

    this.transport = options.transport || new OpencodeServerTransport({
      cwd: this.cwd,
      env: this.env,
      logger: {
        log: (message) => {
          this.writeLog(message);
        },
      },
      config: buildOpencodeConfig(options),
      commandLine: options.commandLine,
      hostname: options.serverHostname,
      port: options.serverPort,
      timeout: options.serverTimeoutMs,
    });
    this.transport.on("process_exit", (payload) => {
      this.handleTransportExit(payload);
    });
    this.transport.on("process_error", (payload) => {
      const error = createTurnError(payload?.message || "Opencode server transport error", payload || {});
      this.handleTransportFailure(error);
    });
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [opencode-sdk] ${message}`);
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
      provider: OPENCODE_PROVIDER_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId || undefined,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: Boolean(this.sessionId),
      manualResume: null,
      pid: this.transport.pid || undefined,
    };
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  async ensureSessionInfo() {
    await this.boot();
    return this.getSessionInfo();
  }

  async getSessionUsageSummary() {
    return {
      sessionId: this.sessionId || undefined,
      sessionFilePath: undefined,
      totalCostUsd: Number.isFinite(Number(this.lastAssistantInfo?.cost))
        ? Number(this.lastAssistantInfo.cost)
        : undefined,
      usage: this.lastUsage ? { ...this.lastUsage } : null,
      rateLimits: null,
      manualResume: null,
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

  async emitWorkingStatus(payload, onProgress = null) {
    const normalized = {
      source: OPENCODE_PROVIDER_VARIANT,
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
    if (typeof onProgress === "function") {
      onProgress(normalized);
    }
    if (typeof this.workingStatusHandler === "function") {
      await this.workingStatusHandler(normalized);
    }
    this.emit("working_status", normalized);
  }

  async emitAssistantMessage(text) {
    const payload = {
      text,
      preserveWhitespace: true,
      source: OPENCODE_PROVIDER_VARIANT,
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
    const error = new Error("Opencode session closed");
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
    const promise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          // best effort
        }
        reject(this.createTurnTimeoutError(this.turnDeadlineMs));
      }, this.turnDeadlineMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
    return {
      promise,
      cleanup: () => {
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
    this.sdkModulePromise = import("@opencode-ai/sdk/v2/client");
    return this.sdkModulePromise;
  }

  async boot() {
    if (this.booted) {
      await this.startEventStream();
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
    if (!sdkModule || typeof sdkModule.createOpencodeClient !== "function") {
      throw new Error("Opencode SDK client is unavailable");
    }

    const { url } = await this.transport.boot();
    this.client = sdkModule.createOpencodeClient({
      baseUrl: url,
      directory: this.cwd,
    });
    await this.startEventStream();

    if (this.resumeSessionId) {
      const session = await this.requestOrThrow(
        this.client.session.get(
          { sessionID: this.resumeSessionId },
          { throwOnError: true, responseStyle: "data" },
        ),
      );
      this.applySessionInfo(session);
      return;
    }

    const session = await this.requestOrThrow(
      this.client.session.create(
        {},
        { throwOnError: true, responseStyle: "data" },
      ),
    );
    this.applySessionInfo(session);
  }

  async startEventStream() {
    if (this.eventStreamPromise) {
      return;
    }
    if (!this.client?.event || typeof this.client.event.subscribe !== "function") {
      throw new Error("Opencode event subscription is unavailable");
    }

    this.eventStreamAbortController = new AbortController();
    const controller = this.eventStreamAbortController;
    let streamResult;
    try {
      streamResult = await this.client.event.subscribe(
        {},
        {
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (this.eventStreamAbortController === controller) {
        this.eventStreamAbortController = null;
      }
      throw error;
    }

    let streamPromise = null;
    streamPromise = (async () => {
      try {
        for await (const event of streamResult.stream) {
          await this.handleOpencodeEvent(event);
        }
        if (!this.closeRequested && !controller.signal.aborted) {
          throw createTurnError("Opencode event stream ended unexpectedly", {
            reason: "event_stream_ended",
          });
        }
      } catch (error) {
        if (controller.signal.aborted && (isAbortError(error) || this.closeRequested)) {
          return;
        }
        this.handleTransportFailure(error);
      } finally {
        if (this.eventStreamPromise === streamPromise) {
          this.eventStreamPromise = null;
        }
        if (this.eventStreamAbortController === controller) {
          this.eventStreamAbortController = null;
        }
      }
    })();

    this.eventStreamPromise = streamPromise;
    streamPromise.catch(() => {
      // handled via handleTransportFailure
    });
  }

  async requestOrThrow(promise) {
    try {
      return await promise;
    } catch (error) {
      this.maybeEmitAuthRequired(error);
      throw error;
    }
  }

  applySessionInfo(session) {
    const normalizedSessionId = typeof session?.id === "string" ? session.id.trim() : "";
    if (!normalizedSessionId) {
      return;
    }
    const changed = this.sessionId !== normalizedSessionId;
    this.sessionId = normalizedSessionId;
    const resolvedModel =
      typeof this.lastAssistantInfo?.model?.modelID === "string" && this.lastAssistantInfo.model.modelID.trim()
        ? this.lastAssistantInfo.model.modelID.trim()
        : typeof this.options.model === "string" && this.options.model.trim()
          ? this.options.model.trim()
          : undefined;
    const resolvedModelProvider =
      typeof this.lastAssistantInfo?.model?.providerID === "string" && this.lastAssistantInfo.model.providerID.trim()
        ? this.lastAssistantInfo.model.providerID.trim()
        : undefined;
    this.sessionInfo = {
      ...(this.sessionInfo || {}),
      backend: this.backend,
      sessionId: normalizedSessionId,
      model: resolvedModel,
      modelProvider: resolvedModelProvider,
    };
    if (changed) {
      this.trace(`session ready id=${normalizedSessionId}`);
      this.emit("session", this.getSessionInfo());
    }
  }

  createAssistantMessageState(currentTurn, messageId) {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedMessageId) {
      return null;
    }
    if (!currentTurn.assistantMessages.has(normalizedMessageId)) {
      currentTurn.assistantMessages.set(normalizedMessageId, {
        id: normalizedMessageId,
        partOrder: [],
        parts: new Map(),
        emitted: false,
        info: null,
      });
      currentTurn.assistantMessageOrder.push(normalizedMessageId);
    }
    return currentTurn.assistantMessages.get(normalizedMessageId);
  }

  bufferPendingMessageEvent(currentTurn, messageId, payload) {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedMessageId) {
      return;
    }
    const existing = currentTurn.pendingMessageEvents.get(normalizedMessageId) || [];
    existing.push(payload);
    currentTurn.pendingMessageEvents.set(normalizedMessageId, existing);
  }

  clearPendingMessageEvents(currentTurn, messageId) {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedMessageId) {
      return [];
    }
    const events = currentTurn.pendingMessageEvents.get(normalizedMessageId) || [];
    currentTurn.pendingMessageEvents.delete(normalizedMessageId);
    return events;
  }

  setPartState(messageState, part) {
    if (!messageState || !part?.id) {
      return null;
    }
    const partId = String(part.id).trim();
    if (!partId) {
      return null;
    }
    if (!messageState.partOrder.includes(partId)) {
      messageState.partOrder.push(partId);
    }
    const existing = messageState.parts.get(partId) || {
      id: partId,
      type: part.type,
      value: "",
      tool: "",
      toolState: null,
    };
    if (part.type === "text" || part.type === "reasoning") {
      existing.value = normalizeText(part.text);
    }
    if (part.type === "tool") {
      existing.tool = normalizeText(part.tool);
      existing.toolState = part.state || null;
    }
    existing.type = part.type;
    messageState.parts.set(partId, existing);
    return existing;
  }

  applyPartDelta(messageState, partId, delta, field) {
    if (!messageState) {
      return null;
    }
    const normalizedPartId = typeof partId === "string" ? partId.trim() : "";
    if (!normalizedPartId) {
      return null;
    }
    const existing = messageState.parts.get(normalizedPartId);
    if (!existing) {
      return null;
    }
    if (field === "text" || field === "delta" || existing.type === "text" || existing.type === "reasoning") {
      existing.value = `${normalizeText(existing.value)}${normalizeText(delta)}`;
      messageState.parts.set(normalizedPartId, existing);
      return existing;
    }
    return existing;
  }

  async processAssistantPartUpdated(currentTurn, part, onProgress) {
    const messageState = this.createAssistantMessageState(currentTurn, part.messageID);
    if (!messageState) {
      return;
    }
    if (
      currentTurn.activeAssistantMessageId &&
      currentTurn.activeAssistantMessageId !== messageState.id
    ) {
      await this.finalizeAssistantMessage(currentTurn, currentTurn.activeAssistantMessageId);
    }
    currentTurn.activeAssistantMessageId = messageState.id;
    const partState = this.setPartState(messageState, part);
    if (part.type === "text") {
      await this.emitWorkingStatus(
        {
          phase: "message_aggregation",
          reply_in_progress: true,
          status_line: statusLineForPhase("message_aggregation"),
          reply_preview: sanitizeSummary(this.collectAssistantText(messageState), 120),
        },
        onProgress,
      );
      return;
    }
    if (part.type === "reasoning") {
      await this.emitWorkingStatus(
        {
          phase: "reasoning",
          reply_in_progress: true,
          status_line: statusLineForPhase("reasoning"),
        },
        onProgress,
      );
      return;
    }
    if (part.type === "tool") {
      const phase = toolPhaseForName(part.tool);
      const toolStatus = part.state?.status === "completed"
        ? part.state?.title || part.state?.output || ""
        : part.state?.title || "";
      await this.emitWorkingStatus(
        {
          phase,
          reply_in_progress: true,
          status_line: sanitizeSummary(toolStatus) || statusLineForPhase(phase, part.tool),
        },
        onProgress,
      );
      if (part.state?.status === "completed" && currentTurn.activeAssistantMessageId !== messageState.id) {
        await this.finalizeAssistantMessage(currentTurn, currentTurn.activeAssistantMessageId);
      }
      return;
    }
    if (part.type === "compaction") {
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
    if (part.type === "step-start") {
      await this.emitWorkingStatus(
        {
          phase: "task_progress",
          reply_in_progress: true,
          status_line: statusLineForPhase("task_progress"),
        },
        onProgress,
      );
      return;
    }
    if (part.type === "step-finish") {
      currentTurn.lastAssistantInfo = currentTurn.lastAssistantInfo || {};
      if (partState && part.tokens) {
        currentTurn.lastAssistantInfo = {
          ...currentTurn.lastAssistantInfo,
          tokens: part.tokens,
          cost: part.cost,
        };
      }
    }
  }

  async processAssistantPartDelta(currentTurn, properties, onProgress) {
    const messageState = this.createAssistantMessageState(currentTurn, properties.messageID);
    const partState = this.applyPartDelta(messageState, properties.partID, properties.delta, properties.field);
    if (partState?.type === "text") {
      await this.emitWorkingStatus(
        {
          phase: "message_aggregation",
          reply_in_progress: true,
          status_line: statusLineForPhase("message_aggregation"),
          reply_preview: sanitizeSummary(this.collectAssistantText(messageState), 120),
        },
        onProgress,
      );
      return;
    }
    if (partState?.type === "reasoning") {
      await this.emitWorkingStatus(
        {
          phase: "reasoning",
          reply_in_progress: true,
          status_line: statusLineForPhase("reasoning"),
        },
        onProgress,
      );
    }
  }

  collectAssistantText(messageState) {
    if (!messageState) {
      return "";
    }
    return messageState.partOrder
      .map((partId) => messageState.parts.get(partId))
      .filter((part) => part?.type === "text")
      .map((part) => normalizeText(part.value))
      .join("");
  }

  async finalizeAssistantMessage(currentTurn, messageId = "") {
    if (!currentTurn) {
      return false;
    }
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    const targetId = normalizedMessageId || currentTurn.activeAssistantMessageId || "";
    if (!targetId) {
      return false;
    }
    const messageState = currentTurn.assistantMessages.get(targetId);
    if (!messageState || messageState.emitted) {
      return false;
    }
    const text = this.collectAssistantText(messageState);
    messageState.emitted = true;
    currentTurn.assistantMessages.set(targetId, messageState);
    if (currentTurn.activeAssistantMessageId === targetId) {
      currentTurn.activeAssistantMessageId = "";
    }
    if (!text) {
      return false;
    }
    currentTurn.fullText += text;
    await this.emitAssistantMessage(text);
    return true;
  }

  buildUsageFromAssistantInfo(info) {
    if (!info?.tokens || typeof info.tokens !== "object") {
      return null;
    }
    const tokens = info.tokens;
    return {
      total: Number.isFinite(Number(tokens.total)) ? Number(tokens.total) : undefined,
      input: Number.isFinite(Number(tokens.input)) ? Number(tokens.input) : undefined,
      output: Number.isFinite(Number(tokens.output)) ? Number(tokens.output) : undefined,
      reasoning: Number.isFinite(Number(tokens.reasoning)) ? Number(tokens.reasoning) : undefined,
      cache: {
        read: Number.isFinite(Number(tokens.cache?.read)) ? Number(tokens.cache.read) : undefined,
        write: Number.isFinite(Number(tokens.cache?.write)) ? Number(tokens.cache.write) : undefined,
      },
    };
  }

  maybeEmitAuthRequired(error) {
    const providerId = error?.data?.providerID;
    const message = extractErrorMessage(error);
    const normalized = `${String(providerId || "")} ${message}`.toLowerCase();
    if (!normalized.includes("auth") && !normalized.includes("login") && !normalized.includes("providerautherror")) {
      return;
    }
    this.emit("auth_required", {
      reason: "login_required",
      message,
      providerId: providerId || undefined,
    });
  }

  async handlePermissionRequest(event, currentTurn) {
    const permission = normalizeText(event?.properties?.permission);
    const patterns = Array.isArray(event?.properties?.patterns)
      ? event.properties.patterns.filter((item) => typeof item === "string" && item.trim())
      : [];
    const details = [permission, ...patterns].filter(Boolean).join(" ");
    await this.emitWorkingStatus(
      {
        phase: "tool_call",
        reply_in_progress: true,
        status_line: sanitizeSummary(details) || statusLineForPhase("tool_call"),
      },
      currentTurn?.onProgress,
    );
    const error = createTurnError(
      details ? `Opencode requested permission: ${details}` : "Opencode requested permission approval",
      {
        reason: "permission_required",
        permission,
        patterns,
      },
    );
    await this.interruptCurrentTurn();
    this.handleTransportFailure(error);
  }

  async handleQuestionRequest(event, currentTurn) {
    const questions = Array.isArray(event?.properties?.questions) ? event.properties.questions : [];
    const summary = questions
      .map((item) => normalizeText(item?.header || item?.question))
      .filter(Boolean)
      .join(" / ");
    await this.emitWorkingStatus(
      {
        phase: "tool_call",
        reply_in_progress: true,
        status_line: sanitizeSummary(summary) || statusLineForPhase("tool_call"),
      },
      currentTurn?.onProgress,
    );
    const error = createTurnError(
      summary ? `Opencode requested user input: ${summary}` : "Opencode requested user input",
      {
        reason: "question_required",
      },
    );
    await this.interruptCurrentTurn();
    this.handleTransportFailure(error);
  }

  async handleOpencodeEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }

    const currentTurn = this.currentTurn;
    const type = normalizeText(event.type);
    const properties = isTruthyPlainObject(event.properties) ? event.properties : {};

    switch (type) {
      case "session.created":
      case "session.updated":
      case "session.deleted":
        this.applySessionInfo(properties.info);
        return;
      case "session.compacted":
        if (!currentTurn || properties.sessionID !== this.sessionId) {
          return;
        }
        await this.emitWorkingStatus(
          {
            phase: "context_compaction",
            reply_in_progress: true,
            status_line: statusLineForPhase("context_compaction"),
          },
          currentTurn.onProgress,
        );
        return;
      case "session.status":
        if (!currentTurn || properties.sessionID !== this.sessionId) {
          return;
        }
        if (properties.status?.type === "retry") {
          await this.emitWorkingStatus(
            {
              phase: "task_progress",
              reply_in_progress: true,
              status_line: sanitizeSummary(properties.status.message) || statusLineForPhase("task_progress"),
            },
            currentTurn.onProgress,
          );
          return;
        }
        if (properties.status?.type === "busy") {
          await this.emitWorkingStatus(
            {
              phase: "turn_started",
              reply_in_progress: true,
              status_line: statusLineForPhase("turn_started"),
            },
            currentTurn.onProgress,
          );
        }
        return;
      case "session.idle":
        if (!currentTurn || properties.sessionID !== this.sessionId) {
          return;
        }
        await this.finalizeAssistantMessage(currentTurn, currentTurn.activeAssistantMessageId);
        if (currentTurn.settled) {
          return;
        }
        currentTurn.settled = true;
        this.activeReplyTarget = "";
        this.lastUsage = this.buildUsageFromAssistantInfo(currentTurn.lastAssistantInfo);
        this.lastAssistantInfo = currentTurn.lastAssistantInfo || null;
        this.applySessionInfo({
          id: this.sessionId,
        });
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_completed",
            status_done_line: "opencode finished",
          },
          currentTurn.onProgress,
        );
        currentTurn.resolve({
          usage: this.lastUsage ? { ...this.lastUsage } : null,
          assistantInfo: currentTurn.lastAssistantInfo || null,
        });
        return;
      case "session.error": {
        const sessionMatches = !properties.sessionID || properties.sessionID === this.sessionId;
        if (!sessionMatches) {
          return;
        }
        const error = properties.error || {};
        this.maybeEmitAuthRequired(error);
        const errorMessage = error?.data?.message || error?.message || "Opencode turn failed";
        this.handleTransportFailure(
          createTurnError(String(errorMessage), {
            reason: "turn_failed",
            error,
          }),
        );
        return;
      }
      case "permission.asked":
        if (!currentTurn || properties.sessionID !== this.sessionId) {
          return;
        }
        await this.handlePermissionRequest(event, currentTurn);
        return;
      case "question.asked":
        if (!currentTurn || properties.sessionID !== this.sessionId) {
          return;
        }
        await this.handleQuestionRequest(event, currentTurn);
        return;
      case "todo.updated":
        if (!currentTurn || properties.sessionID !== this.sessionId) {
          return;
        }
        await this.emitWorkingStatus(
          {
            phase: "planning",
            reply_in_progress: true,
            status_line: statusLineForPhase("planning"),
          },
          currentTurn.onProgress,
        );
        return;
      case "message.updated": {
        if (!currentTurn || properties.info?.sessionID !== this.sessionId) {
          return;
        }
        const info = properties.info;
        currentTurn.items.push(event);
        const messageId = typeof info.id === "string" ? info.id.trim() : "";
        if (messageId) {
          currentTurn.messageRoles.set(messageId, info.role);
        }
        if (info.role !== "assistant") {
          this.clearPendingMessageEvents(currentTurn, messageId);
          return;
        }
        const messageState = this.createAssistantMessageState(currentTurn, messageId);
        if (!messageState) {
          return;
        }
        if (
          currentTurn.activeAssistantMessageId &&
          currentTurn.activeAssistantMessageId !== messageState.id
        ) {
          await this.finalizeAssistantMessage(currentTurn, currentTurn.activeAssistantMessageId);
        }
        currentTurn.activeAssistantMessageId = messageState.id;
        messageState.info = info;
        currentTurn.lastAssistantInfo = info;
        currentTurn.assistantMessages.set(messageState.id, messageState);
        for (const pendingEvent of this.clearPendingMessageEvents(currentTurn, messageState.id)) {
          if (pendingEvent?.type === "part.updated") {
            await this.processAssistantPartUpdated(currentTurn, pendingEvent.part, currentTurn.onProgress);
            continue;
          }
          if (pendingEvent?.type === "part.delta") {
            await this.processAssistantPartDelta(currentTurn, pendingEvent.properties, currentTurn.onProgress);
          }
        }
        await this.emitWorkingStatus(
          {
            phase: "message_aggregation",
            reply_in_progress: true,
            status_line: statusLineForPhase("message_aggregation"),
          },
          currentTurn.onProgress,
        );
        return;
      }
      case "message.part.updated": {
        if (!currentTurn || properties.part?.sessionID !== this.sessionId) {
          return;
        }
        currentTurn.items.push(event);
        const part = properties.part;
        const messageRole = currentTurn.messageRoles.get(part.messageID);
        if (messageRole && messageRole !== "assistant") {
          return;
        }
        if (!messageRole) {
          this.bufferPendingMessageEvent(currentTurn, part.messageID, {
            type: "part.updated",
            part,
          });
          return;
        }
        await this.processAssistantPartUpdated(currentTurn, part, currentTurn.onProgress);
        return;
      }
      case "message.part.delta": {
        if (!currentTurn || properties.sessionID !== this.sessionId) {
          return;
        }
        currentTurn.items.push(event);
        const messageRole = currentTurn.messageRoles.get(properties.messageID);
        if (messageRole && messageRole !== "assistant") {
          return;
        }
        if (!messageRole) {
          this.bufferPendingMessageEvent(currentTurn, properties.messageID, {
            type: "part.delta",
            properties: { ...properties },
          });
          return;
        }
        await this.processAssistantPartDelta(currentTurn, properties, currentTurn.onProgress);
        return;
      }
      default:
        if (currentTurn) {
          currentTurn.items.push(event);
        }
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
    const exitError = createTurnError("Opencode server exited", {
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

  async interruptCurrentTurn() {
    const currentTurn = this.currentTurn;
    if (!currentTurn || !this.client?.session || !this.sessionId) {
      return;
    }
    try {
      currentTurn.abortController?.abort?.();
    } catch {
      // best effort
    }
    try {
      await this.client.session.abort(
        { sessionID: this.sessionId },
        { throwOnError: true, responseStyle: "data" },
      );
    } catch {
      // best effort
    }
  }

  async runTurn(promptText, { useInitialImages = false, onProgress = null } = {}) {
    if (this.closeRequested) {
      throw this.createSessionClosedError();
    }

    const effectivePrompt = this.buildPrompt(promptText, { useInitialImages });
    if (!effectivePrompt) {
      return buildEmptyTurnResult();
    }

    await this.boot();

    if (this.currentTurn) {
      throw createTurnError("Opencode turn already running", {
        reason: "turn_already_running",
      });
    }

    if (!this.client?.session || typeof this.client.session.promptAsync !== "function") {
      throw new Error("Opencode session client is unavailable");
    }

    this.history.push({ role: "user", content: promptText });

    const abortController = new AbortController();
    const currentTurn = {
      abortController,
      assistantMessages: new Map(),
      assistantMessageOrder: [],
      activeAssistantMessageId: "",
      messageRoles: new Map(),
      pendingMessageEvents: new Map(),
      fullText: "",
      items: [],
      lastAssistantInfo: null,
      onProgress,
      resolve: null,
      reject: null,
      settled: false,
      terminalWorkingStatusEmitted: false,
    };
    const completionPromise = new Promise((resolve, reject) => {
      currentTurn.resolve = resolve;
      currentTurn.reject = reject;
    });
    this.currentTurn = currentTurn;

    const closeGuard = this.createCloseGuard(() => {
      abortController.abort();
      void this.interruptCurrentTurn();
    });
    const turnTimeoutGuard = this.createTurnTimeoutGuard(() => {
      abortController.abort();
      void this.interruptCurrentTurn();
    });

    try {
      await this.emitWorkingStatus(
        {
          phase: "turn_started",
          reply_in_progress: true,
          status_line: "opencode is working",
        },
        onProgress,
      );

      const completion = await Promise.race([
        (async () => {
          await this.requestOrThrow(
            this.client.session.promptAsync(
              {
                sessionID: this.sessionId,
                agent:
                  typeof this.options.agent === "string" && this.options.agent.trim()
                    ? this.options.agent.trim()
                    : undefined,
                system:
                  typeof this.options.systemPrompt === "string" && this.options.systemPrompt.trim()
                    ? this.options.systemPrompt.trim()
                    : typeof this.options.system === "string" && this.options.system.trim()
                      ? this.options.system.trim()
                      : undefined,
                tools: isTruthyPlainObject(this.options.tools) ? { ...this.options.tools } : undefined,
                variant:
                  typeof this.options.variant === "string" && this.options.variant.trim()
                    ? this.options.variant.trim()
                    : undefined,
                parts: [
                  {
                    type: "text",
                    text: effectivePrompt,
                  },
                ],
              },
              {
                throwOnError: true,
                responseStyle: "data",
                signal: abortController.signal,
              },
            ),
          );
          return await completionPromise;
        })(),
        closeGuard.promise,
        turnTimeoutGuard.promise,
      ]);

      await this.finalizeAssistantMessage(currentTurn, currentTurn.activeAssistantMessageId);

      if (currentTurn.fullText) {
        this.history.push({ role: "assistant", content: currentTurn.fullText });
      }

      this.activeReplyTarget = "";

      return {
        text: currentTurn.fullText,
        usage: completion?.usage || null,
        items: currentTurn.items,
        events: currentTurn.items,
        provider: this.backend,
        metadata: {
          source: OPENCODE_PROVIDER_VARIANT,
          sessionId: this.sessionId || undefined,
          totalCostUsd: Number.isFinite(Number(completion?.assistantInfo?.cost))
            ? Number(completion.assistantInfo.cost)
            : undefined,
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
            status_done_line: extractErrorMessage(error),
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
    await this.interruptCurrentTurn();
    try {
      this.eventStreamAbortController?.abort?.();
    } catch {
      // best effort
    }
    await this.transport.close();
    this.closed = true;
  }
}
