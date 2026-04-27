import { EventEmitter } from "node:events";

import {
  emitLog,
  loadEnvConfig,
  normalizeLogger,
  reviveError,
  sanitizeForLog,
} from "../shared.js";

const REMOTE_PROVIDER_CONFIG = {
  "codex-remote": {
    targetBackend: "codex",
    provider: "codex-remote",
    urlEnvKeys: ["CONDUCTOR_CODEX_REMOTE_URL", "CONDUCTOR_REMOTE_AI_URL", "CONDUCTOR_SERVE_AI_URL"],
    apiKeyEnvKeys: [
      "CONDUCTOR_CODEX_REMOTE_API_KEY",
      "CONDUCTOR_REMOTE_AI_API_KEY",
      "CONDUCTOR_SERVE_AI_API_KEY",
    ],
  },
  "claude-remote": {
    targetBackend: "claude",
    provider: "claude-remote",
    urlEnvKeys: ["CONDUCTOR_CLAUDE_REMOTE_URL", "CONDUCTOR_REMOTE_AI_URL", "CONDUCTOR_SERVE_AI_URL"],
    apiKeyEnvKeys: [
      "CONDUCTOR_CLAUDE_REMOTE_API_KEY",
      "CONDUCTOR_REMOTE_AI_API_KEY",
      "CONDUCTOR_SERVE_AI_API_KEY",
    ],
  },
};

const REMOTE_OPTION_KEYS = new Set([
  "agentBaseUrl",
  "apiKey",
  "baseUrl",
  "fetchImpl",
  "logger",
  "remoteApiKey",
  "remoteBaseUrl",
  "remoteCwd",
  "remoteUrl",
  "serveAiUrl",
]);

const SERVER_OWNED_OPTION_KEYS = new Set([
  "commandLine",
  "configFile",
  "env",
  "jsonSchema",
  "logger",
  "now",
  "outputFormat",
  "responseFormat",
  "sdkModule",
  "structuredOutput",
  "disableWorker",
]);

const REMOTE_CREATE_OPTION_KEYS = new Set([
  "initialHistory",
  "model",
  "resumeSessionId",
]);

function normalizeBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "code-remote") {
    return "codex-remote";
  }
  if (normalized === "claude-code-remote") {
    return "claude-remote";
  }
  return normalized;
}

function firstStringValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function resolveEnv(options = {}) {
  const envConfig = loadEnvConfig(options.configFile);
  return {
    ...process.env,
    ...(envConfig && typeof envConfig === "object" ? envConfig : {}),
    ...(options.env && typeof options.env === "object" ? options.env : {}),
  };
}

function resolveFromEnv(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function makeUrl(baseUrl, pathname) {
  const normalizedBase = String(baseUrl || "").trim();
  if (!normalizedBase) {
    throw new Error("remoteBaseUrl is required");
  }
  const base = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  return new URL(String(pathname || "").replace(/^\/+/, ""), base);
}

function isJsonSerializable(value) {
  if (value === undefined || typeof value === "function") {
    return false;
  }
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function cloneJsonValue(value) {
  if (!isJsonSerializable(value)) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function buildRemoteSessionOptions(options) {
  const remoteOptions = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (
      REMOTE_OPTION_KEYS.has(key) ||
      SERVER_OWNED_OPTION_KEYS.has(key) ||
      !REMOTE_CREATE_OPTION_KEYS.has(key)
    ) {
      continue;
    }
    if (!isJsonSerializable(value)) {
      continue;
    }
    remoteOptions[key] = cloneJsonValue(value);
  }
  return remoteOptions;
}

function extractDefaultJsonSchema(options = {}) {
  if (options.jsonSchema && typeof options.jsonSchema === "object") {
    return cloneJsonValue(options.jsonSchema);
  }
  const outputFormat = options.outputFormat || options.responseFormat;
  if (outputFormat && typeof outputFormat === "object" && outputFormat.schema && typeof outputFormat.schema === "object") {
    return cloneJsonValue(outputFormat.schema);
  }
  return null;
}

async function parseErrorResponse(response) {
  const text = await response.text().catch(() => "");
  if (!text) {
    return `remote agent request failed with HTTP ${response.status}`;
  }
  try {
    const parsed = JSON.parse(text);
    return (
      parsed?.error?.message ||
      parsed?.message ||
      `remote agent request failed with HTTP ${response.status}`
    );
  } catch {
    return text.trim() || `remote agent request failed with HTTP ${response.status}`;
  }
}

export class RemoteAgentSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = normalizeBackend(backend);
    this.providerConfig = REMOTE_PROVIDER_CONFIG[this.backend];
    if (!this.providerConfig) {
      throw new Error(`Unsupported remote AI backend "${backend}"`);
    }

    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.env = resolveEnv(options);
    this.baseUrl = firstStringValue(
      options.remoteBaseUrl,
      options.remoteUrl,
      options.serveAiUrl,
      options.agentBaseUrl,
      options.baseUrl,
      resolveFromEnv(this.env, this.providerConfig.urlEnvKeys),
    );
    if (!this.baseUrl) {
      throw new Error(
        `${this.backend} requires remoteBaseUrl or ${this.providerConfig.urlEnvKeys.join("/")}`,
      );
    }
    this.apiKey = firstStringValue(
      options.remoteApiKey,
      options.apiKey,
      resolveFromEnv(this.env, this.providerConfig.apiKeyEnvKeys),
    );
    this.fetchImpl = options.fetchImpl || fetch;
    if (options.remoteCwd !== undefined) {
      this.trace("remoteCwd is ignored; configure the working directory on the remote serve-ai process instead");
    }
    this.remoteOptions = buildRemoteSessionOptions(options);
    this.defaultJsonSchema = extractDefaultJsonSchema(options);
    this.remoteAgentSessionId = "";
    this.sessionInfo = null;
    this.currentTurnStatus = null;
    this.sessionMessageHandler = null;
    this.workingStatusHandler = null;
    this.replyTarget = undefined;
    this.closed = false;
    this.threadIdValue =
      typeof options.resumeSessionId === "string" && options.resumeSessionId.trim()
        ? options.resumeSessionId.trim()
        : "";
    this.threadOptionsValue = {
      model:
        typeof options.model === "string" && options.model.trim()
          ? options.model.trim()
          : this.backend,
    };
    this.snapshot = {
      backend: this.backend,
      provider: this.providerConfig.provider,
      remoteBackend: this.providerConfig.targetBackend,
      sessionId: this.threadIdValue || undefined,
      sessionInfo: null,
      useSessionFileReplyStream: true,
      currentTurnStatus: null,
    };
    this.createPromise = this.createRemoteSession();
    this.createPromise.catch(() => {
      // Surface the error to the first operation that needs the remote session.
    });
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [remote-agent] ${message}`);
  }

  get threadId() {
    return this.threadIdValue;
  }

  get threadOptions() {
    return {
      ...this.threadOptionsValue,
      ...(this.sessionInfo?.model ? { model: this.sessionInfo.model } : {}),
      ...(this.sessionInfo?.modelProvider ? { modelProvider: this.sessionInfo.modelProvider } : {}),
    };
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      backend: this.backend,
      provider: this.providerConfig.provider,
      remoteBackend: this.providerConfig.targetBackend,
      sessionId: this.threadIdValue || undefined,
      sessionInfo: this.getSessionInfo(),
      currentTurnStatus: this.getCurrentTurnStatus(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
    };
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  getCurrentTurnStatus() {
    return this.currentTurnStatus ? { ...this.currentTurnStatus } : null;
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
    this.replyTarget = replyTo;
    void this.callRemoteMethod("setSessionReplyTarget", [replyTo]).catch((error) => {
      if (error?.reason !== "session_closed") {
        this.trace(`failed to set reply target: ${sanitizeForLog(error?.message || error)}`);
      }
    });
  }

  async ensureSessionInfo() {
    const result = await this.callRemoteMethod("ensureSessionInfo", []);
    this.applySessionInfo(result);
    return this.getSessionInfo();
  }

  async getSessionUsageSummary() {
    return await this.callRemoteMethod("getSessionUsageSummary", []);
  }

  async interruptCurrentTurn() {
    return await this.callRemoteMethod("interruptCurrentTurn", []);
  }

  async runTurn(promptText, options = {}) {
    if (this.closed) {
      throw this.createSessionClosedError();
    }
    await this.ensureRemoteSession();
    const runOptions = options && typeof options === "object" ? { ...options } : {};
    const onProgress = typeof runOptions.onProgress === "function" ? runOptions.onProgress : null;
    delete runOptions.onProgress;
    if (!runOptions.jsonSchema && this.defaultJsonSchema) {
      runOptions.jsonSchema = cloneJsonValue(this.defaultJsonSchema);
    }

    const response = await this.fetchRemote(`/internal/agent/sessions/${encodeURIComponent(this.remoteAgentSessionId)}/run-turn`, {
      promptText,
      options: runOptions,
    });
    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }

    let result;
    let remoteError = null;
    await this.readNdjson(response, async (payload) => {
      if (payload?.type === "event") {
        await this.applyRemoteEvent(payload.name, payload.payload);
        return;
      }
      if (payload?.type === "progress") {
        if (payload.payload && typeof payload.payload === "object") {
          this.currentTurnStatus = { ...payload.payload };
        }
        if (typeof onProgress === "function") {
          onProgress(payload.payload);
        }
        return;
      }
      if (payload?.type === "result") {
        if (payload.snapshot && typeof payload.snapshot === "object") {
          this.applySnapshot(payload.snapshot);
        }
        result = payload.result;
        return;
      }
      if (payload?.type === "error") {
        remoteError = reviveError(payload.error);
      }
    });

    if (remoteError) {
      throw remoteError;
    }
    if (result === undefined) {
      throw new Error("remote agent runTurn ended without a result");
    }
    if (result && typeof result === "object" && result.sessionId) {
      this.threadIdValue = String(result.sessionId);
    }
    return result;
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.callRemoteMethod("close", []);
    } catch {
      // best effort
    }
  }

  createSessionClosedError() {
    const error = new Error("remote AI session closed");
    error.reason = "session_closed";
    return error;
  }

  async createRemoteSession() {
    const response = await this.requestJson("/internal/agent/sessions", {
      backend: this.providerConfig.targetBackend,
      options: this.remoteOptions,
    });
    this.remoteAgentSessionId = String(response.sessionId || response.id || "").trim();
    if (!this.remoteAgentSessionId) {
      throw new Error("remote agent create response is missing sessionId");
    }
    if (response.snapshot && typeof response.snapshot === "object") {
      this.applySnapshot(response.snapshot);
    }
    if (response.sessionInfo && typeof response.sessionInfo === "object") {
      this.applySessionInfo(response.sessionInfo);
    }
    if (this.replyTarget !== undefined) {
      await this.callRemoteMethod("setSessionReplyTarget", [this.replyTarget]);
    }
  }

  async ensureRemoteSession() {
    if (this.remoteAgentSessionId) {
      return this.remoteAgentSessionId;
    }
    if (this.closed) {
      throw this.createSessionClosedError();
    }
    await this.createPromise;
    return this.remoteAgentSessionId;
  }

  async callRemoteMethod(method, args = []) {
    if (this.closed && method !== "close") {
      throw this.createSessionClosedError();
    }
    await this.ensureRemoteSession();
    const response = await this.requestJson(
      `/internal/agent/sessions/${encodeURIComponent(this.remoteAgentSessionId)}/request`,
      {
        method,
        args: Array.isArray(args) ? args : [],
      },
    );
    if (response.snapshot && typeof response.snapshot === "object") {
      this.applySnapshot(response.snapshot);
    }
    return response.result;
  }

  async requestJson(pathname, payload) {
    const response = await this.fetchRemote(pathname, payload);
    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }
    return await response.json();
  }

  async fetchRemote(pathname, payload) {
    const headers = {
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return await this.fetchImpl(makeUrl(this.baseUrl, pathname), {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    });
  }

  async readNdjson(response, onPayload) {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      await this.consumeNdjsonText(text, onPayload);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          await this.consumeNdjsonLine(line, onPayload);
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (done) {
        const tail = buffer.trim();
        if (tail) {
          await this.consumeNdjsonLine(tail, onPayload);
        }
        return;
      }
    }
  }

  async consumeNdjsonText(text, onPayload) {
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
      const normalized = line.trim();
      if (normalized) {
        await this.consumeNdjsonLine(normalized, onPayload);
      }
    }
  }

  async consumeNdjsonLine(line, onPayload) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid remote agent stream line: ${error?.message || error}`);
    }
    await onPayload(payload);
  }

  applySnapshot(snapshot) {
    const remoteSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    this.snapshot = {
      ...this.snapshot,
      sessionId: remoteSnapshot.sessionId || this.threadIdValue || undefined,
      currentTurnStatus:
        remoteSnapshot.currentTurnStatus && typeof remoteSnapshot.currentTurnStatus === "object"
          ? { ...remoteSnapshot.currentTurnStatus }
          : this.currentTurnStatus,
    };
    if (remoteSnapshot.sessionId) {
      this.threadIdValue = String(remoteSnapshot.sessionId);
    }
    if (remoteSnapshot.sessionInfo && typeof remoteSnapshot.sessionInfo === "object") {
      this.applySessionInfo(remoteSnapshot.sessionInfo);
    }
  }

  applySessionInfo(sessionInfo) {
    if (!sessionInfo || typeof sessionInfo !== "object") {
      return;
    }
    this.sessionInfo = {
      ...sessionInfo,
      backend: this.backend,
      remoteBackend: this.providerConfig.targetBackend,
    };
    if (sessionInfo.sessionId) {
      this.threadIdValue = String(sessionInfo.sessionId);
    }
    this.snapshot = {
      ...this.snapshot,
      sessionId: this.threadIdValue || undefined,
      sessionInfo: this.getSessionInfo(),
    };
  }

  async applyRemoteEvent(name, payload) {
    const eventName = String(name || "").trim();
    if (!eventName) {
      return;
    }
    if (eventName === "session" && payload && typeof payload === "object") {
      this.applySessionInfo(payload);
    }
    if (eventName === "working_status" && payload && typeof payload === "object") {
      this.currentTurnStatus = { ...payload };
      this.snapshot = {
        ...this.snapshot,
        currentTurnStatus: this.getCurrentTurnStatus(),
      };
    }
    if (eventName === "assistant_message" && typeof this.sessionMessageHandler === "function") {
      await this.sessionMessageHandler(payload);
    }
    if (eventName === "working_status" && typeof this.workingStatusHandler === "function") {
      await this.workingStatusHandler(payload);
    }
    this.emit(eventName, payload);
  }
}
