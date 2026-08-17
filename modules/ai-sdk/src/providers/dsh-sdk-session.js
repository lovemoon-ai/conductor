import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DSH_SDK_VARIANT } from "../built-in-backends.js";
import {
  emitLog,
  extractLongFlagFromCommandLine,
  getBoundedEnvInt,
  loadEnvConfig,
  normalizeLogger,
  proxyToEnv,
  sanitizeForLog,
} from "../shared.js";

const require = createRequire(import.meta.url);

const DEFAULT_TURN_DEADLINE_MS = 12 * 60 * 1000;
const MIN_TURN_DEADLINE_MS = 30 * 1000;
const MAX_TURN_DEADLINE_MS = 30 * 60 * 1000;

// Pinned defaults for the dsh runtime route. `deepseek-official` is the
// provider route the stock `@deepseek-ai/dsh-llm-deepseek` adapter registers;
// the model can be overridden via options.model or an allow_cli_list command
// like `dsh --model deepseek-v4`.
const DEFAULT_DSH_PROVIDER = "deepseek-official";
const DEFAULT_DSH_MODEL = "deepseek-v4-flash";

const CORDIS_CONFIG_PATH = fileURLToPath(new URL("../../dsh/cordis.yml", import.meta.url));

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

function normalizeDshBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "deepseek-harness") {
    return "dsh";
  }
  return normalized || "dsh";
}

export function defaultDshSessionRoot() {
  return path.join(os.homedir(), ".conductor", "dsh-sessions");
}

function extractTextBlocks(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

function toolPhaseForName(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized) {
    return "tool_call";
  }
  if (normalized.includes("bash") || normalized.includes("pwsh") || normalized.includes("terminal")) {
    return "command_execution";
  }
  if (normalized.includes("str_replace") || normalized.includes("edit") || normalized.includes("write")) {
    return "file_update";
  }
  if (normalized.includes("fs") || normalized.includes("read") || normalized.includes("search") || normalized.includes("glob")) {
    return "workspace_inspection";
  }
  if (normalized.includes("web") || normalized.includes("fetch")) {
    return "web_lookup";
  }
  if (normalized.includes("subagent") || normalized.includes("todo") || normalized.includes("workflow")) {
    return "task_progress";
  }
  return "tool_call";
}

function statusLineForPhase(phase, toolName = "") {
  switch (phase) {
    case "context_compaction":
      return "dsh compacting context";
    case "command_execution":
      return "dsh running command";
    case "file_update":
      return "dsh editing files";
    case "workspace_inspection":
      return "dsh reading workspace";
    case "web_lookup":
      return "dsh browsing";
    case "message_aggregation":
      return "dsh composing reply";
    case "task_progress":
      return toolName ? `dsh running ${toolName}` : "dsh running task";
    case "tool_call":
      return toolName ? `dsh calling ${toolName}` : "dsh calling tool";
    default:
      return "dsh is working";
  }
}

function accumulateUsage(total, usage) {
  if (!usage || typeof usage !== "object") {
    return total;
  }
  const next = total && typeof total === "object" ? { ...total } : {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ]) {
    const value = Number(usage[key]);
    if (Number.isFinite(value)) {
      next[key] = (Number.isFinite(Number(next[key])) ? Number(next[key]) : 0) + value;
    }
  }
  return next;
}

/**
 * DeepSeek Harness (dsh) backend session.
 *
 * Drives a dsh runtime subprocess through `@deepseek-ai/dsh-sdk-client`
 * (stdio JSON-RPC). The runtime composition is the package-owned
 * `dsh/cordis.yml`; the pinned runtime bin comes from
 * `@deepseek-ai/dsh-sdk-jsonrpc-demo`. One DshSdkSession owns at most one
 * runtime subprocess across turns; the dsh-side session id is minted by us
 * (or taken from resumeSessionId) so the same conversation resumes across
 * runtime restarts through dsh's JSONL session persistence.
 *
 * Interrupt semantics: the dsh SDK wire has NO mid-turn cancel. Interrupting
 * closes the runtime subprocess (SIGTERM ladder inside the SDK client) and
 * the next runTurn spawns a fresh runtime resuming the same session id.
 */
export class DshSdkSession extends EventEmitter {
  static capabilities = Object.freeze({ goal: false });

  getCapabilities() {
    return { ...DshSdkSession.capabilities };
  }

  constructor(backend, options = {}) {
    super();
    this.backend = normalizeDshBackend(backend);
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    this.resumeSessionId =
      typeof options.resumeSessionId === "string" ? options.resumeSessionId.trim() : "";
    // dsh session ids are client-minted. The SDK runtime (rc.6) can only
    // CREATE sessions — prompting an id whose JSONL log already exists on
    // disk fails with an id collision. So the wire id is always fresh;
    // resuming seeds the previous session's conversation history into the
    // first prompt instead (loaded lazily from the persisted log).
    this.pendingResumeFromSessionId = this.resumeSessionId;
    this.sessionId = `session-${randomUUID().replaceAll("-", "")}`;
    this.sessionIdUsed = false;
    this.model =
      (typeof options.model === "string" && options.model.trim()) ||
      extractLongFlagFromCommandLine(options.commandLine, "model") ||
      DEFAULT_DSH_MODEL;
    this.dshProvider =
      (typeof options.dshProvider === "string" && options.dshProvider.trim()) ||
      extractLongFlagFromCommandLine(options.commandLine, "provider") ||
      DEFAULT_DSH_PROVIDER;
    const maxTokens = Number(options.maxTokens);
    this.maxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : undefined;
    this.sessionRoot =
      typeof options.dshSessionRoot === "string" && options.dshSessionRoot.trim()
        ? options.dshSessionRoot.trim()
        : defaultDshSessionRoot();
    this.sessionInfo = {
      backend: this.backend,
      sessionId: this.sessionId,
      model: this.model,
      modelProvider: this.dshProvider,
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
    this.manualResumeReady = Boolean(this.resumeSessionId);
    this.sessionAnnounced = false;
    this.currentTurn = null;
    this.harness = null;
    this.lastUsage = null;
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
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [dsh-sdk] ${message}`);
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: DSH_SDK_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: true,
      resumeReady: this.manualResumeReady,
      manualResume: null,
      currentTurnStatus: this.getCurrentTurnStatus(),
      capabilities: this.getCapabilities(),
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
      sessionId: this.sessionId,
      sessionFilePath: undefined,
      totalCostUsd: undefined,
      usage: this.lastUsage ? { ...this.lastUsage } : null,
      modelUsage: null,
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

  async emitWorkingStatus(payload, onProgress = null) {
    const normalized = {
      source: DSH_SDK_VARIANT,
      reply_in_progress: Boolean(payload?.reply_in_progress),
      replyTo: payload?.replyTo || this.getCurrentReplyTarget(),
      state: payload?.state,
      phase: payload?.phase,
      status_line: payload?.status_line,
      status_done_line: payload?.status_done_line,
      reply_preview: payload?.reply_preview,
      thread_id: this.sessionId,
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
      source: DSH_SDK_VARIANT,
      replyTo: this.getCurrentReplyTarget(),
      sessionId: this.sessionId,
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

  announceSession() {
    if (this.sessionAnnounced) {
      return;
    }
    this.sessionAnnounced = true;
    this.manualResumeReady = true;
    this.trace(`session ready id=${this.sessionId}`);
    this.emit("session", this.getSessionInfo());
  }

  /**
   * Mint a fresh wire session id after the previous one's runtime was torn
   * down (interrupt/timeout). The persisted log of the old id would collide
   * on the next create, so the conversation continues on a new id seeded
   * with the in-memory history; the new id is re-announced on success.
   */
  rotateSessionId() {
    const previousSessionId = this.sessionId;
    this.sessionId = `session-${randomUUID().replaceAll("-", "")}`;
    this.sessionIdUsed = false;
    this.sessionAnnounced = false;
    this.pendingHistorySeed = this.history.length > 0;
    this.sessionInfo = { ...this.sessionInfo, sessionId: this.sessionId };
    this.trace(`rotated session id ${previousSessionId} -> ${this.sessionId}`);
  }

  findPersistedSessionLog(sessionId) {
    const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalized) {
      return null;
    }
    let projectEntries = [];
    try {
      projectEntries = fs.readdirSync(this.sessionRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      const candidate = path.join(this.sessionRoot, projectEntry.name, normalized, "session.jsonl");
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // keep scanning
      }
    }
    return null;
  }

  /**
   * Recover the user/assistant conversation from a persisted dsh JSONL log
   * so a cross-process resume can seed it into the fresh wire session.
   */
  loadPersistedHistory(sessionId) {
    const logPath = this.findPersistedSessionLog(sessionId);
    if (!logPath) {
      return [];
    }
    const restored = [];
    let content;
    try {
      content = fs.readFileSync(logPath, "utf8");
    } catch {
      return [];
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (event?.type === "user/message" && event.data?.source?.kind === "user") {
        const text = extractTextBlocks(event.data?.content);
        if (text) {
          restored.push({ role: "user", content: text });
        }
        continue;
      }
      if (event?.type === "assistant/message") {
        const text = extractTextBlocks(event.data?.message?.content);
        if (text) {
          restored.push({ role: "assistant", content: text });
        }
      }
    }
    return restored;
  }

  createSessionClosedError() {
    const error = new Error("dsh SDK session closed");
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

  resolveLaunchSpec() {
    if (typeof this.options.dshRuntimeCommand === "string" && this.options.dshRuntimeCommand.trim()) {
      return {
        command: this.options.dshRuntimeCommand.trim(),
        args: Array.isArray(this.options.dshRuntimeArgs)
          ? this.options.dshRuntimeArgs.map((item) => String(item))
          : [],
      };
    }
    let runtimeBin;
    try {
      runtimeBin = require.resolve("@deepseek-ai/dsh-sdk-jsonrpc-demo/bin");
    } catch (error) {
      throw createTurnError(
        "dsh runtime is unavailable: @deepseek-ai/dsh-sdk-jsonrpc-demo is not installed"
          + ` (${error?.message || error})`,
        { reason: "runtime_unavailable" },
      );
    }
    return {
      command: process.execPath,
      args: [runtimeBin, CORDIS_CONFIG_PATH],
    };
  }

  buildRuntimeEnv() {
    const env = {
      ...process.env,
      ...this.env,
      DSH_CWD: this.cwd,
      DSH_SESSION_ROOT: this.sessionRoot,
    };
    const systemPrompt =
      typeof this.options.systemPrompt === "string" && this.options.systemPrompt.trim()
        ? this.options.systemPrompt.trim()
        : "";
    if (systemPrompt) {
      env.DSH_SYSTEM_PROMPT = systemPrompt;
    }
    return env;
  }

  async getSdkModule() {
    if (this.sdkModulePromise) {
      return this.sdkModulePromise;
    }
    if (this.options.sdkModule && typeof this.options.sdkModule === "object") {
      this.sdkModulePromise = Promise.resolve(this.options.sdkModule);
      return this.sdkModulePromise;
    }
    this.sdkModulePromise = import("@deepseek-ai/dsh-sdk-client");
    return this.sdkModulePromise;
  }

  async getHarness() {
    if (this.harness) {
      return this.harness;
    }
    const sdkModule = await this.getSdkModule();
    if (!sdkModule || typeof sdkModule.DeepSeekHarness !== "function") {
      throw new Error("dsh SDK client is unavailable");
    }
    const launch = this.resolveLaunchSpec();
    this.trace(`launching runtime: ${launch.command} ${launch.args.join(" ")}`);
    this.harness = new sdkModule.DeepSeekHarness({
      launch: {
        command: launch.command,
        args: launch.args,
        cwd: this.cwd,
        env: this.buildRuntimeEnv(),
      },
      cwd: this.cwd,
      provider: this.dshProvider,
      model: this.model,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    });
    return this.harness;
  }

  async disposeHarness() {
    const harness = this.harness;
    this.harness = null;
    if (!harness) {
      return;
    }
    try {
      await harness.close();
    } catch {
      // best effort
    }
  }

  maybeEmitAuthRequired(message) {
    const normalized = String(message || "").toLowerCase();
    if (!normalized) {
      return;
    }
    if (!/(api key|credential|unauthorized|401|auth)/.test(normalized)) {
      return;
    }
    this.emit("auth_required", {
      reason: "login_required",
      message: String(message),
    });
  }

  async handleNotification(notification, currentTurn, { onProgress }) {
    this.touchTurnActivity();
    // Token-level replay chunks are high-volume and carry nothing the bridge
    // consumes; keep `items` at message/tool granularity so the result stays
    // small crossing the worker IPC boundary.
    if (notification?.params?.event?.type !== "assistant/chunk") {
      currentTurn.items.push(notification);
    }

    if (notification?.method === "session.status") {
      if (notification.params?.sessionId !== this.sessionId) {
        return;
      }
      if (notification.params?.status === "running") {
        await this.emitWorkingStatus(
          {
            phase: "turn_started",
            reply_in_progress: true,
            status_line: "dsh is working",
          },
          onProgress,
        );
      }
      return;
    }

    if (notification?.method === "subagent.started") {
      await this.emitWorkingStatus(
        {
          phase: "task_progress",
          reply_in_progress: true,
          status_line: "dsh delegating to subagent",
        },
        onProgress,
      );
      return;
    }

    if (notification?.method === "subagent.finished") {
      await this.emitWorkingStatus(
        {
          phase: "task_progress",
          reply_in_progress: true,
          status_line: `dsh subagent ${notification.params?.status === "ok" ? "finished" : "failed"}`,
        },
        onProgress,
      );
      return;
    }

    if (notification?.method !== "session.event" || notification.params?.sessionId !== this.sessionId) {
      return;
    }

    const event = notification.params?.event;
    switch (event?.type) {
      case "assistant/message": {
        const usage = event.data?.usage;
        if (usage) {
          currentTurn.usage = accumulateUsage(currentTurn.usage, usage);
          this.lastUsage = accumulateUsage(this.lastUsage, usage);
        }
        const text = extractTextBlocks(event.data?.message?.content);
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
            reply_preview: sanitizeForLog(text, 120),
          },
          onProgress,
        );
        await this.emitAssistantMessage(text);
        return;
      }
      case "tool/call": {
        const toolName = String(event.data?.name || "");
        const phase = toolPhaseForName(toolName);
        const argsPreview = sanitizeForLog(event.data?.arguments, 120);
        await this.emitWorkingStatus(
          {
            phase,
            reply_in_progress: true,
            status_line: statusLineForPhase(phase, toolName) + (argsPreview ? `: ${argsPreview}` : ""),
          },
          onProgress,
        );
        return;
      }
      case "todo/write": {
        const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
        const done = todos.filter((item) => item?.status === "completed").length;
        await this.emitWorkingStatus(
          {
            phase: "task_progress",
            reply_in_progress: true,
            status_line: `dsh todo ${done}/${todos.length}`,
          },
          onProgress,
        );
        return;
      }
      case "compaction/start": {
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
      case "turn/end": {
        currentTurn.turnEndReason = event.data?.reason || null;
        return;
      }
      default:
        return;
    }
  }

  async interruptCurrentTurn() {
    const currentTurn = this.currentTurn;
    if (!currentTurn) {
      return false;
    }
    // The dsh SDK wire has no mid-turn cancel: tear the runtime down and let
    // the next turn respawn it, resuming the same persisted session id. The
    // signal also settles a turn that has not attached its runtime yet.
    currentTurn.interrupted = true;
    currentTurn.signalInterrupt?.();
    await this.disposeHarness();
    return true;
  }

  async runTurn(promptText, { useInitialImages = false, onProgress = null } = {}) {
    if (this.closeRequested) {
      throw this.createSessionClosedError();
    }

    if (!String(promptText || "").trim()) {
      return {
        text: "",
        usage: null,
        items: [],
        events: [],
      };
    }

    if (this.currentTurn) {
      throw createTurnError("dsh SDK turn already running", {
        reason: "turn_already_running",
      });
    }

    if (this.pendingResumeFromSessionId) {
      const restored = this.loadPersistedHistory(this.pendingResumeFromSessionId);
      this.trace(
        `restored ${restored.length} messages from resumed session ${this.pendingResumeFromSessionId}`,
      );
      this.pendingResumeFromSessionId = "";
      if (restored.length > 0) {
        this.history = [...restored, ...this.history];
        this.pendingHistorySeed = true;
      }
    }

    // A fresh runtime cannot prompt an id whose log is already on disk;
    // continue on a rotated id seeded with the in-memory history.
    if (!this.harness && this.sessionIdUsed) {
      this.rotateSessionId();
    }

    const effectivePrompt = this.buildPrompt(promptText, { useInitialImages });
    this.history.push({ role: "user", content: promptText });

    const currentTurn = {
      emittedAssistantMessage: false,
      fullText: "",
      interrupted: false,
      items: [],
      terminalWorkingStatusEmitted: false,
      turnEndReason: null,
      usage: null,
    };
    this.currentTurn = currentTurn;
    this.updateCurrentTurnStatus({
      source: DSH_SDK_VARIANT,
      reply_in_progress: true,
      replyTo: this.getCurrentReplyTarget(),
      phase: "turn_started",
      status_line: "dsh is working",
      thread_id: this.sessionId,
    });

    const closeGuard = this.createCloseGuard(() => {
      void this.disposeHarness();
    });
    const turnTimeoutGuard = this.createTurnTimeoutGuard(() => {
      currentTurn.interrupted = true;
      void this.disposeHarness();
    });
    // Settles the turn on interrupt even before the runtime is attached (an
    // interrupt during getHarness() would otherwise leave the run dangling).
    const interruptGuard = new Promise((_, reject) => {
      currentTurn.signalInterrupt = () =>
        reject(createTurnError("dsh turn interrupted", { reason: "turn_interrupted" }));
    });
    // The guard may reject before the race below attaches its handler; keep
    // that early rejection observed so it never surfaces as unhandled.
    interruptGuard.catch(() => {});

    try {
      await this.emitWorkingStatus(
        {
          phase: "turn_started",
          reply_in_progress: true,
          status_line: "dsh is working",
        },
        onProgress,
      );

      if (currentTurn.interrupted) {
        throw createTurnError("dsh turn interrupted", { reason: "turn_interrupted" });
      }
      const harness = await this.getHarness();
      // Serialize notification handling so event translation keeps wire order
      // and the turn only settles after the last notification is processed.
      let notificationQueue = Promise.resolve();
      this.sessionIdUsed = true;
      const runResult = await Promise.race([
        harness.session(this.sessionId).run(effectivePrompt, {
          onNotification: (notification) => {
            notificationQueue = notificationQueue.then(() =>
              this.handleNotification(notification, currentTurn, { onProgress }),
            ).catch(() => {});
          },
        }),
        closeGuard.promise,
        turnTimeoutGuard.promise,
        interruptGuard,
      ]);
      await notificationQueue;

      this.announceSession();

      const responseText =
        typeof runResult?.finalResponse === "string" && runResult.finalResponse
          ? runResult.finalResponse
          : currentTurn.fullText;

      if (!currentTurn.emittedAssistantMessage && responseText) {
        await this.emitAssistantMessage(responseText);
      }

      if (responseText) {
        this.history.push({ role: "assistant", content: responseText });
      }

      const turnEndKind = currentTurn.turnEndReason?.kind;
      if (turnEndKind && turnEndKind !== "completed" && turnEndKind !== "max-tokens") {
        const detail =
          typeof currentTurn.turnEndReason?.error?.message === "string" &&
          currentTurn.turnEndReason.error.message
            ? `: ${currentTurn.turnEndReason.error.message}`
            : "";
        const errorMessage = `dsh turn ended with reason "${turnEndKind}"${detail}`;
        this.maybeEmitAuthRequired(errorMessage);
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
          turnStatus: turnEndKind,
        });
      }

      this.activeReplyTarget = "";

      await this.emitTerminalWorkingStatus(
        currentTurn,
        {
          phase: "turn_completed",
          status_done_line: "dsh finished",
        },
        onProgress,
      );

      return {
        text: responseText,
        usage: currentTurn.usage ? { ...currentTurn.usage } : null,
        items: currentTurn.items,
        events: [],
        provider: this.backend,
        metadata: {
          source: DSH_SDK_VARIANT,
          sessionId: this.sessionId,
          model: this.model,
          modelProvider: this.dshProvider,
          turnEndReason: currentTurn.turnEndReason || undefined,
        },
      };
    } catch (error) {
      if (error?.reason === "turn_timeout") {
        // Runtime already torn down by the timeout guard.
        this.trace(`turn timed out after ${this.turnDeadlineMs}ms`);
      }
      if (currentTurn.interrupted && error?.reason !== "turn_timeout" && error?.reason !== "session_closed") {
        const interruptError = createTurnError("dsh turn interrupted", {
          reason: "turn_interrupted",
        });
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_failed",
            status_done_line: "dsh turn interrupted",
          },
          onProgress,
        );
        throw interruptError;
      }
      if (this.closeRequested && error?.reason !== "session_closed") {
        throw this.createSessionClosedError();
      }
      if (!this.closeRequested && error?.reason !== "session_closed") {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.emitTerminalWorkingStatus(
          currentTurn,
          {
            phase: "turn_failed",
            status_done_line: errorMessage || "dsh turn failed",
          },
          onProgress,
        );
      }
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
      this.currentTurn.interrupted = true;
    }
    await this.disposeHarness();
    this.closed = true;
  }
}
