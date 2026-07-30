import { EventEmitter } from "node:events";

import { CHAT_WEB_SESSION_VARIANT } from "../built-in-backends.js";
import { PROVIDER_MEDIA_CAPABILITIES } from "../media-adapters.js";
import { assertMediaCapabilities, resolveTurnMedia } from "../media-input.js";
import { emitLog, normalizeLogger } from "../shared.js";

const SUPPORTED_CHAT_WEB_PROVIDERS = new Set(["chatgpt", "gemini"]);
const DEFAULT_CHAT_WEB_PROVIDER = "chatgpt";
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

function normalizeChatWebProvider(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "";
  // Friendly aliases. "openai" / "gpt" → chatgpt, "google" → gemini.
  if (raw === "openai" || raw === "gpt" || raw === "chat-gpt") return "chatgpt";
  if (raw === "google" || raw === "aistudio" || raw === "ai-studio") return "gemini";
  return raw;
}

function resolveChatWebProvider(options = {}) {
  const candidates = [options.chatWebProvider, options.provider, options.model];
  for (const candidate of candidates) {
    const normalized = normalizeChatWebProvider(candidate);
    if (SUPPORTED_CHAT_WEB_PROVIDERS.has(normalized)) {
      return normalized;
    }
  }
  return DEFAULT_CHAT_WEB_PROVIDER;
}

function extractErrorMessage(error) {
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "chat-web turn failed";
}

/**
 * Bridges the ai-sdk logger shape (`{ log(msg) }`) to chat-web's shape
 * (`{ error, warn, info, debug }`). Chat-web internally calls
 * `logger.debug(...)` and friends during session lifecycle; if we pass
 * the ai-sdk logger straight through, those calls explode with
 * "this.logger.debug is not a function" mid-turn.
 *
 * Routes every chat-web level into the ai-sdk logger's single `log`
 * channel, prefixed with the level so downstream observers can still
 * grep the structure. Safe against undefined / partial loggers.
 */
function adaptLoggerForChatWeb(aiSdkLogger) {
  const sinkLog = typeof aiSdkLogger?.log === "function" ? aiSdkLogger.log.bind(aiSdkLogger) : null;
  const at = (level) => (...args) => {
    if (!sinkLog) return;
    try {
      sinkLog(`[chat-web ${level}] ${args.map(formatLoggerArg).join(" ")}`);
    } catch {
      // best effort
    }
  };
  return {
    level: "info",
    error: at("error"),
    warn: at("warn"),
    info: at("info"),
    debug: at("debug"),
  };
}

function formatLoggerArg(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlaywrightMissingError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("cannot find package 'playwright") ||
    msg.includes("cannot find module 'playwright") ||
    msg.includes("npx playwright install")
  );
}

/**
 * AI SDK provider that delegates to the chat-web runtime
 * (`@love-moon/chat-web`), which automates a real Chromium browser against
 * ChatGPT / Gemini / DeepSeek and ferries conversations through their web
 * UIs. Choose the underlying chat-web provider via:
 *
 *   - `options.chatWebProvider`: "chatgpt" | "gemini"  (preferred)
 *   - `options.provider`:        same surface
 *   - `options.model`:           same surface (fallback for ergonomic
 *                                `createAiSession("chat-web", { model: "gemini" })`)
 *
 * Defaults to "chatgpt". Aliases: "openai"/"gpt" → chatgpt, "google" → gemini.
 *
 * Lifecycle:
 *   - `boot()` lazily imports `@love-moon/chat-web`, registers its built-in
 *     providers, and opens a long-lived `ChatSession` (headed by default).
 *   - `runTurn(prompt)` calls `session.send(prompt)` and emits a single
 *     `assistant_message` with the model's reply.
 *   - `close()` tears the Chromium context down.
 *
 * Resume: chat-web's "session" is a Chromium browser context, not a
 * conversation ID — there is no native cross-process resume. We synthesise
 * an id so the rest of ai-sdk has something stable to thread on, but
 * passing `resumeSessionId` does not reattach to a prior conversation.
 */
export class ChatWebSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = "chat-web";
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.chatWebProvider = resolveChatWebProvider(options);
    // Match chat-web SDK's own default (headed). Per chat-web/core/browser.ts
    // resolveHeadless(), headed mode is the documented safe default for
    // anti-bot heuristics — ChatGPT/AI Studio routinely serve unauthenticated
    // or challenge pages to chrome-headless-shell even when profile cookies
    // are valid, which masquerades as "not logged in" downstream. The old
    // `options.headless !== false` defaulted to true and effectively neutered
    // chat-web's anti-bot stance whenever the caller (daemon, serve-ai)
    // didn't explicitly pass a value. Users who actually want headless must
    // now opt in with an explicit `headless: true`.
    this.headless = options.headless === true;
    // Optional: use a specific Chromium-family binary (system Chrome /
    // Edge / explicit path) instead of Playwright's bundled
    // `chrome-headless-shell`. Useful when the user's network treats
    // chrome-headless-shell differently from real Chrome. Note:
    // this does NOT bypass Google's WAA anti-abuse on AI Studio.
    this.browserChannel =
      typeof options.browserChannel === "string" && options.browserChannel.trim()
        ? options.browserChannel.trim()
        : "";
    this.browserExecutablePath =
      typeof options.browserExecutablePath === "string" && options.browserExecutablePath.trim()
        ? options.browserExecutablePath.trim()
        : "";
    this.turnTimeoutMs =
      Number.isFinite(options.turnTimeoutMs) && options.turnTimeoutMs > 0
        ? Math.round(options.turnTimeoutMs)
        : DEFAULT_TURN_TIMEOUT_MS;
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();

    // Synthetic id used until the provider exposes its real conversation
    // id (e.g. ChatGPT navigates to /c/{uuid} after the first turn). The
    // synthetic value lets callers thread on `sessionId` immediately,
    // before the browser has even opened.
    this.sessionId =
      typeof options.resumeSessionId === "string" && options.resumeSessionId.trim()
        ? options.resumeSessionId.trim()
        : `chat-web-${this.chatWebProvider}-${Date.now().toString(36)}`;
    /** Real provider-side conversation id, populated after the first turn lands. */
    this.providerConversationId = undefined;
    this.sessionInfo = {
      backend: this.backend,
      sessionId: this.sessionId,
      model: this.chatWebProvider,
      modelProvider: "chat-web",
    };

    this.chatSession = null;
    this.booted = false;
    this.bootPromise = null;
    this.closeRequested = false;
    this.closed = false;

    this.currentTurn = null;
    this.currentTurnStatus = null;
    this.sessionMessageHandler = null;
    this.workingStatusHandler = null;
    this.activeReplyTarget = "";
    this.lastReplyTarget = "";
    this.history = Array.isArray(options.initialHistory)
      ? [...options.initialHistory]
      : [];
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [chat-web] ${message}`);
  }

  get threadId() {
    return this.sessionId;
  }

  get threadOptions() {
    return {
      model: this.chatWebProvider,
      modelProvider: "chat-web",
    };
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: CHAT_WEB_SESSION_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: Boolean(this.providerConversationId),
      manualResume: this.providerConversationUrl()
        ? { ready: true, command: this.providerConversationUrl() }
        : null,
      currentTurnStatus: this.getCurrentTurnStatus(),
      capabilities: { media: PROVIDER_MEDIA_CAPABILITIES[CHAT_WEB_SESSION_VARIANT] },
      chatWebProvider: this.chatWebProvider,
      providerConversationId: this.providerConversationId,
      providerUrl: this.providerConversationUrl(),
    };
  }

  getSessionInfo() {
    if (!this.sessionInfo) return null;
    // chat-web's "real" session id is the provider-side conversation id
    // (e.g. ChatGPT /c/{uuid}), which only lands AFTER the first turn.
    // Until then, our synthetic "chat-web-{provider}-{ts}" id is just a
    // local handle — surfacing it to the daemon would lead to ugly UI
    // copy like "web-chatgpt session started: chat-web-chatgpt-mpgw7cd1".
    //
    // We expose `sessionIdDeferred: true` so the fire-side announce can
    // hold off until the real id arrives, then re-announce.
    const hasRealId = Boolean(this.providerConversationId);
    return {
      ...this.sessionInfo,
      sessionIdDeferred: !hasRealId,
    };
  }

  getCurrentTurnStatus() {
    return this.currentTurnStatus ? { ...this.currentTurnStatus } : null;
  }

  usesSessionFileReplyStream() {
    // chat-web doesn't persist a JSONL session file; replies are emitted
    // in-process via the assistant_message event.
    return false;
  }

  setSessionMessageHandler(handler) {
    this.sessionMessageHandler = typeof handler === "function" ? handler : null;
  }

  setWorkingStatusHandler(handler) {
    this.workingStatusHandler = typeof handler === "function" ? handler : null;
  }

  setSessionReplyTarget(replyTo) {
    const normalized = typeof replyTo === "string" ? replyTo.trim() : "";
    this.activeReplyTarget = normalized;
    if (normalized) {
      this.lastReplyTarget = normalized;
    }
  }

  getCurrentReplyTarget() {
    return this.activeReplyTarget || this.lastReplyTarget || undefined;
  }

  async ensureSessionInfo() {
    await this.boot();
    return this.getSessionInfo();
  }

  async getSessionUsageSummary() {
    // chat-web has no token / cost telemetry — it's a browser puppeteer,
    // not an API client.
    return {
      sessionId: this.sessionId,
      sessionFilePath: undefined,
      totalCostUsd: undefined,
      usage: null,
      rateLimits: null,
      manualResume: null,
    };
  }

  async getChatWebModule() {
    if (this.options.chatWebModule && typeof this.options.chatWebModule === "object") {
      return this.options.chatWebModule;
    }
    try {
      return await import("@love-moon/chat-web");
    } catch (error) {
      if (isPlaywrightMissingError(error)) {
        const enriched = new Error(
          `@love-moon/chat-web requires Playwright Chromium. Run: npx playwright install chromium`,
        );
        enriched.cause = error;
        throw enriched;
      }
      const enriched = new Error(
        `Failed to load @love-moon/chat-web: ${extractErrorMessage(error)}. ` +
          `Install it with: npm install @love-moon/chat-web playwright`,
      );
      enriched.cause = error;
      throw enriched;
    }
  }

  async boot() {
    if (this.booted) return;
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.bootInternal();
    try {
      await this.bootPromise;
      this.booted = true;
    } finally {
      this.bootPromise = null;
    }
  }

  async bootInternal() {
    if (this.closeRequested) {
      throw this.createSessionClosedError();
    }
    const mod = await this.getChatWebModule();
    if (typeof mod.registerBuiltinProviders === "function") {
      mod.registerBuiltinProviders();
    }
    if (typeof mod.ChatSession?.open !== "function") {
      throw new Error("Loaded @love-moon/chat-web is missing ChatSession.open");
    }

    // Forward optional browser-binary overrides to chat-web. The env vars
    // CHAT_WEB_BROWSER_CHANNEL / CHAT_WEB_BROWSER_EXECUTABLE are also
    // honoured by chat-web directly, so they apply even when nothing is
    // passed here.
    const launch = {};
    if (this.browserChannel) launch.channel = this.browserChannel;
    if (this.browserExecutablePath) launch.executablePath = this.browserExecutablePath;

    this.chatSession = await mod.ChatSession.open(this.chatWebProvider, {
      headless: this.headless,
      // IMPORTANT: chat-web's logger contract is `{ error, warn, info, debug }`;
      // ai-sdk's normalised logger is `{ log }`. Passing the ai-sdk logger
      // through verbatim crashes chat-web mid-session with
      // "this.logger.debug is not a function". Adapt to chat-web's shape.
      logger: adaptLoggerForChatWeb(this.logger),
      ...(Object.keys(launch).length > 0 ? { launch } : {}),
    });

    if (this.closeRequested) {
      await this.chatSession.close().catch(() => undefined);
      this.chatSession = null;
      throw this.createSessionClosedError();
    }

    const loggedIn = await this.chatSession.isLoggedIn().catch(() => false);
    if (!loggedIn) {
      const error = new Error(
        `chat-web provider "${this.chatWebProvider}" is not logged in. Run: chat-web login ${this.chatWebProvider}`,
      );
      error.reason = "not_logged_in";
      this.emit("auth_required", {
        reason: "login_required",
        message: error.message,
      });
      throw error;
    }

    this.trace(`session ready provider=${this.chatWebProvider} id=${this.sessionId}`);
    this.emit("session", this.getSessionInfo());
  }

  /**
   * Adopt the provider-side conversation id (ChatGPT /c/{uuid} or
   * equivalent) as our canonical sessionId, update sessionInfo, and emit
   * a fresh `session` event so downstream consumers (ai-sdk runner,
   * conductor daemon, web UI) pick up the change.
   *
   * Idempotent on identical values. Once promoted, the id stays stable
   * for the rest of this ChatWebSession (next runTurn won't re-promote
   * to something else unless the provider session truly changes).
   */
  applyProviderConversationId(conversationId) {
    const normalized = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!normalized) return;
    if (normalized === this.providerConversationId) return;
    this.providerConversationId = normalized;
    this.sessionId = normalized;
    this.sessionInfo = {
      ...(this.sessionInfo || {}),
      backend: this.backend,
      sessionId: normalized,
      model: this.chatWebProvider,
      modelProvider: "chat-web",
      providerConversationId: normalized,
      providerUrl: this.providerConversationUrl(),
    };
    this.trace(`adopted provider conversation id ${normalized}`);
    this.emit("session", this.getSessionInfo());
  }

  /**
   * Build a deep-link to the provider's conversation page so the UI can
   * render "open in ChatGPT" / "open in AI Studio" links.
   */
  providerConversationUrl() {
    if (!this.providerConversationId) return undefined;
    switch (this.chatWebProvider) {
      case "chatgpt":
        return `https://chatgpt.com/c/${this.providerConversationId}`;
      case "gemini":
        // chat-web's `gemini` provider targets AI Studio
        // (aistudio.google.com/prompts/new_chat) — that's the free web
        // chat surface users call "Gemini". Once a prompt is saved,
        // the URL becomes /prompts/{slug}.
        return `https://aistudio.google.com/prompts/${this.providerConversationId}`;
      default:
        return undefined;
    }
  }

  async runTurn(promptText, { useInitialImages = false, media: mediaInput, onProgress = null } = {}) {
    const media = resolveTurnMedia(this.options, { useInitialImages, media: mediaInput });
    assertMediaCapabilities(media, this.backend, PROVIDER_MEDIA_CAPABILITIES[CHAT_WEB_SESSION_VARIANT]);
    const prompt = String(promptText || "").trim();
    if (!prompt) {
      return {
        text: "",
        usage: null,
        items: [],
        events: [],
        provider: this.backend,
        metadata: {
          source: CHAT_WEB_SESSION_VARIANT,
          sessionId: this.sessionId,
          chatWebProvider: this.chatWebProvider,
        },
      };
    }
    if (this.currentTurn) {
      const error = new Error("chat-web turn already in progress");
      error.reason = "turn_already_running";
      throw error;
    }

    this.currentTurn = { aborted: false };
    await this.emitWorkingStatus(
      {
        phase: "turn_started",
        reply_in_progress: true,
        status_line: `chat-web (${this.chatWebProvider}) is working`,
      },
      onProgress,
    );

    try {
      await this.boot();
      if (this.closeRequested) throw this.createSessionClosedError();

      const result = await this.chatSession.send(prompt, {
        timeoutMs: this.turnTimeoutMs,
        onProgress: (text) => {
          // chat-web's onProgress fires while streaming text grows; we
          // forward those as working_status updates with a short preview.
          void this.emitWorkingStatus(
            {
              phase: "message_aggregation",
              reply_in_progress: true,
              status_line: `chat-web (${this.chatWebProvider}) streaming`,
              reply_preview: typeof text === "string" ? text.slice(-120) : undefined,
            },
            onProgress,
          );
        },
      });

      const text = String(result?.response ?? "").trim();

      // Adopt the provider's real conversation id once it lands (e.g.
      // ChatGPT's /c/{uuid}). This replaces the synthetic
      // "chat-web-{provider}-{ts}" id we minted at construction so
      // downstream callers (UI, daemon, persistence) see the real
      // provider-side id and can deep-link straight to chatgpt.com/c/...
      const conversationId =
        typeof result?.conversationId === "string" && result.conversationId.trim()
          ? result.conversationId.trim()
          : typeof this.chatSession?.conversationId === "string" && this.chatSession.conversationId.trim()
            ? this.chatSession.conversationId.trim()
            : "";
      if (conversationId && conversationId !== this.sessionId) {
        this.applyProviderConversationId(conversationId);
      }

      if (text) {
        this.history.push({ role: "assistant", content: text });
        await this.emitAssistantMessage(text);
      }

      await this.emitTerminalWorkingStatus(
        {
          phase: this.currentTurn.aborted ? "turn_interrupted" : "turn_completed",
          status_done_line: this.currentTurn.aborted
            ? `chat-web (${this.chatWebProvider}) interrupted`
            : `chat-web (${this.chatWebProvider}) finished`,
        },
        onProgress,
      );

      return {
        text,
        usage: null,
        items: [],
        events: [],
        provider: this.backend,
        metadata: {
          source: CHAT_WEB_SESSION_VARIANT,
          sessionId: this.sessionId,
          chatWebProvider: this.chatWebProvider,
          conversationId: this.providerConversationId,
          providerUrl: this.providerConversationUrl(),
          turnIndex: result?.turnIndex,
          durationMs: result?.durationMs,
        },
      };
    } catch (error) {
      const message = extractErrorMessage(error);
      const code = typeof error?.code === "string" ? error.code : "";
      // Surface chat-web's typed "needs API key" / "permission denied"
      // errors as auth_required so the UI / daemon can route them
      // through the same flow as ChatGPT's "not logged in" — they're
      // all "operator action required" failures, not transient errors.
      if (code === "PROVIDER_API_KEY_REQUIRED" || code === "PROVIDER_PERMISSION_DENIED") {
        this.emit("auth_required", {
          reason: code === "PROVIDER_API_KEY_REQUIRED" ? "api_key_required" : "permission_denied",
          message,
          provider: this.chatWebProvider,
          hint: error?.hint,
        });
      }
      await this.emitTerminalWorkingStatus(
        {
          phase: this.currentTurn?.aborted ? "turn_interrupted" : "turn_failed",
          status_done_line: message,
        },
        onProgress,
      );
      throw error;
    } finally {
      this.activeReplyTarget = "";
      this.currentTurn = null;
    }
  }

  async interruptCurrentTurn() {
    // chat-web's ChatSession doesn't expose a turn abort — the underlying
    // Chromium tab is still busy with the model. We mark the turn as
    // aborted so the next status emission is "interrupted", but the
    // assistant_message may still arrive once the model finishes.
    if (this.currentTurn) {
      this.currentTurn.aborted = true;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closeRequested = true;
    if (this.chatSession) {
      try {
        await this.chatSession.close();
      } catch {
        // best effort
      }
      this.chatSession = null;
    }
  }

  createSessionClosedError() {
    const error = new Error("chat-web session closed");
    error.reason = "session_closed";
    return error;
  }

  async emitWorkingStatus(payload, onProgress = null) {
    const updatedAtMs = Date.now();
    const normalized = {
      source: CHAT_WEB_SESSION_VARIANT,
      reply_in_progress: Boolean(payload?.reply_in_progress),
      replyTo: payload?.replyTo || this.getCurrentReplyTarget(),
      state: payload?.state,
      phase: payload?.phase,
      status_line: payload?.status_line,
      status_done_line: payload?.status_done_line,
      reply_preview: payload?.reply_preview,
      thread_id: this.sessionId,
      session_id: this.sessionId,
      session_file_path: undefined,
      updated_at: new Date(updatedAtMs).toISOString(),
    };
    this.currentTurnStatus = normalized;
    if (typeof onProgress === "function") {
      try {
        onProgress(normalized);
      } catch {
        // best effort
      }
    }
    if (typeof this.workingStatusHandler === "function") {
      await this.workingStatusHandler(normalized);
    }
    this.emit("working_status", normalized);
  }

  async emitTerminalWorkingStatus(payload, onProgress = null) {
    await this.emitWorkingStatus(
      { ...payload, reply_in_progress: false },
      onProgress,
    );
  }

  async emitAssistantMessage(text) {
    const payload = {
      text,
      preserveWhitespace: true,
      source: CHAT_WEB_SESSION_VARIANT,
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
}

export { SUPPORTED_CHAT_WEB_PROVIDERS, DEFAULT_CHAT_WEB_PROVIDER };
