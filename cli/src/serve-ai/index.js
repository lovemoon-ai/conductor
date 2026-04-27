import http from "node:http";
import { randomUUID } from "node:crypto";
import { createAiSession } from "@love-moon/ai-sdk";

import {
  buildChatTurn,
  normalizeResponseFormat,
  normalizeStructuredOutputResult,
  toOpenAiChatCompletion,
} from "./adapter.js";
import { loadServeAiRuntimeConfig } from "./config.js";
import { sendJson, sendOpenAiError } from "./errors.js";
import { materializeImageInputs } from "./image-handler.js";
import {
  listAdvertisedBackends,
  normalizeRuntimeBackendAlias,
  normalizeRuntimeBackendName,
  resolveConfiguredRuntimeBackend,
  isRuntimeSupportedBackend,
} from "../runtime-backends.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_REQUEST_BODY_LIMIT = 25 * 1024 * 1024;
const DEFAULT_AGENT_SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_AGENT_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_AGENT_SESSION_MAX_COUNT = 16;
const DEFAULT_AGENT_SESSION_INTERRUPT_TIMEOUT_MS = 2000;

function createHttpError(
  message,
  { statusCode = 400, type = "invalid_request_error", code = "invalid_request", param = null } = {},
) {
  const error = new Error(String(message || "request error"));
  error.statusCode = statusCode;
  error.openAiType = type;
  error.openAiCode = code;
  error.openAiParam = param;
  return error;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseCommandParts(commandLine) {
  const input = String(commandLine || "").trim();
  if (!input) {
    return [];
  }

  const parts = [];
  let current = "";
  let quote = "";
  let escaping = false;
  let tokenStarted = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        parts.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (tokenStarted) {
    parts.push(current);
  }

  return parts;
}

function extractModelOptionFromCommandLine(commandLine) {
  const parts = parseCommandParts(commandLine);
  for (let index = 0; index < parts.length; index += 1) {
    const token = String(parts[index] || "").trim();
    if (!token) {
      continue;
    }
    if (token === "--model") {
      const next = String(parts[index + 1] || "").trim();
      return next || "";
    }
    if (token.startsWith("--model=")) {
      return token.slice("--model=".length).trim();
    }
  }
  return "";
}

function resolveAiSessionCommandLine(backend, allowCliList, env = process.env, sessionBackend = backend) {
  const normalizedBackend = normalizeRuntimeBackendName(backend);
  const normalizedSessionBackend = normalizeRuntimeBackendName(sessionBackend);
  const envKeyByBackend = {
    codex: "CONDUCTOR_CODEX_APP_SERVER_COMMAND",
    opencode: "CONDUCTOR_OPENCODE_COMMAND",
    kimi: "CONDUCTOR_KIMI_COMMAND",
  };
  const envKey = envKeyByBackend[normalizedSessionBackend];
  const preferredEnvCommand = envKey && typeof env?.[envKey] === "string" ? env[envKey].trim() : "";
  if (preferredEnvCommand) {
    return preferredEnvCommand;
  }

  const configuredCommand =
    allowCliList && typeof allowCliList === "object"
      ? typeof allowCliList[normalizedBackend] === "string"
        ? allowCliList[normalizedBackend].trim()
        : typeof allowCliList[normalizedSessionBackend] === "string"
          ? allowCliList[normalizedSessionBackend].trim()
          : ""
      : "";
  const daemonCommand =
    typeof env?.CONDUCTOR_CLI_COMMAND === "string" ? env.CONDUCTOR_CLI_COMMAND.trim() : "";
  const resolvedCommand = configuredCommand || daemonCommand;
  if (!resolvedCommand) {
    return "";
  }
  if (normalizedSessionBackend === "codex") {
    if (/\bapp-server\b/.test(resolvedCommand)) {
      return resolvedCommand;
    }
    return `${resolvedCommand} app-server --listen stdio://`;
  }
  return resolvedCommand;
}

function resolveAiSessionOptions(backend, allowCliList, env = process.env, sessionBackend = backend) {
  const commandLine = resolveAiSessionCommandLine(backend, allowCliList, env, sessionBackend);
  const model = extractModelOptionFromCommandLine(commandLine);
  return model ? { model } : {};
}

function parseAuthorizationHeader(headerValue) {
  const normalized = String(headerValue || "").trim();
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : normalized;
}

async function readJsonBody(req, { maxBytes = DEFAULT_REQUEST_BODY_LIMIT } = {}) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw createHttpError(`request body exceeds ${maxBytes} bytes`, {
        statusCode: 413,
        code: "body_too_large",
      });
    }
    chunks.push(buffer);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw createHttpError("request body must be valid JSON", {
      code: "invalid_json",
    });
  }
}

function serializeInternalError(error) {
  const includeStack = /^(1|true|yes)$/i.test(String(process.env.CONDUCTOR_SERVE_AI_DEBUG_ERRORS || "").trim());
  if (error instanceof Error) {
    const payload = {
      name: error.name,
      message: error.message,
    };
    if (includeStack && error.stack) {
      payload.stack = error.stack;
    }
    for (const key of ["code", "reason", "statusCode"]) {
      if (error[key] !== undefined) {
        payload[key] = error[key];
      }
    }
    return payload;
  }
  if (error && typeof error === "object") {
    return {
      name: String(error.name || "Error"),
      message: String(error.message || "Unknown error"),
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
    };
  }
  return { message: String(error || "Unknown error") };
}

function sendNdjsonHeaders(res) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
}

async function writeNdjson(res, payload) {
  if (res.destroyed) {
    return false;
  }
  const canContinue = res.write(`${JSON.stringify(payload)}\n`);
  if (canContinue) {
    return true;
  }
  await new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
  return !res.destroyed;
}

function normalizeInternalAgentBackend(backend) {
  const normalized = normalizeRuntimeBackendName(backend);
  if (normalized === "codex-remote" || normalized === "code-remote") {
    return "codex";
  }
  if (normalized === "claude-remote" || normalized === "claude-code-remote") {
    return "claude";
  }
  if (normalized === "codex" || normalized === "claude") {
    return normalized;
  }
  throw createHttpError(`unsupported internal agent backend: ${backend || ""}`, {
    statusCode: 400,
    code: "unsupported_agent_backend",
    param: "backend",
  });
}

const INTERNAL_AGENT_CREATE_OPTION_KEYS = new Set([
  "initialHistory",
  "model",
  "resumeSessionId",
]);

const INTERNAL_AGENT_RUN_OPTION_KEYS = new Set(["jsonSchema", "useInitialImages"]);

function cloneJsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function sanitizeInternalAgentCreateOptions(options) {
  if (!options || typeof options !== "object") {
    return {};
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(options)) {
    if (!INTERNAL_AGENT_CREATE_OPTION_KEYS.has(key) || typeof value === "function" || value === undefined) {
      continue;
    }
    const cloned = cloneJsonValue(value);
    if (cloned !== undefined) {
      sanitized[key] = cloned;
    }
  }
  return sanitized;
}

function sanitizeInternalAgentRunOptions(options) {
  if (!options || typeof options !== "object") {
    return {};
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(options)) {
    if (!INTERNAL_AGENT_RUN_OPTION_KEYS.has(key) || value === undefined) {
      continue;
    }
    const cloned = cloneJsonValue(value);
    if (cloned !== undefined) {
      sanitized[key] = cloned;
    }
  }
  return sanitized;
}

async function closeAgentSession(state, sessionId, reason = "closed") {
  const normalizedSessionId = String(sessionId || "").trim();
  const entry = normalizedSessionId ? state.agentSessions.get(normalizedSessionId) : null;
  if (!entry) {
    return false;
  }
  state.agentSessions.delete(normalizedSessionId);
  await runBestEffortWithTimeout(
    () => entry.session?.interruptCurrentTurn?.(),
    state.agentSessionInterruptTimeoutMs,
    (error) => {
      state.logger.log?.(
        `[serve-ai] [agent] failed to interrupt session ${normalizedSessionId} (${reason}): ${error?.message || error}`,
      );
    },
  );
  try {
    await entry.session?.close?.();
  } catch (error) {
    state.logger.log?.(`[serve-ai] [agent] failed to close session ${normalizedSessionId} (${reason}): ${error?.message || error}`);
  }
  return true;
}

function createInProcessAiSession(backend, options, createAiSessionImpl = createAiSession) {
  return createAiSessionImpl(backend, {
    ...options,
    disableWorker: true,
  });
}

function delayMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    timer.unref?.();
  });
}

async function runBestEffortWithTimeout(fn, timeoutMs, onError) {
  const operation = Promise.resolve()
    .then(fn)
    .catch((error) => {
      onError?.(error);
    });
  await Promise.race([operation, delayMs(timeoutMs)]);
}

async function sweepAgentSessions(state) {
  const now = state.now();
  const staleSessionIds = [];
  for (const [sessionId, entry] of state.agentSessions.entries()) {
    if (entry.activeRuns > 0) {
      continue;
    }
    if (now - entry.lastActiveAt >= state.agentSessionIdleTtlMs) {
      staleSessionIds.push(sessionId);
    }
  }
  await Promise.all(staleSessionIds.map((sessionId) => closeAgentSession(state, sessionId, "idle_timeout")));
  return staleSessionIds.length;
}

function tryReserveAgentSessionSlot(state) {
  if (state.agentSessions.size + state.agentSessionReservations >= state.agentSessionMaxCount) {
    return null;
  }
  state.agentSessionReservations += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.agentSessionReservations = Math.max(0, state.agentSessionReservations - 1);
  };
}

async function reserveAgentSessionSlot(state) {
  const immediateReservation = tryReserveAgentSessionSlot(state);
  if (immediateReservation) {
    return immediateReservation;
  }
  await sweepAgentSessions(state);
  const reservation = tryReserveAgentSessionSlot(state);
  if (reservation) {
    return reservation;
  }
  throw createHttpError("too many active agent sessions", {
    statusCode: 429,
    type: "rate_limit_error",
    code: "agent_session_limit_exceeded",
  });
}

function getAgentSessionEntry(state, sessionId, { touch = true } = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  const entry = normalizedSessionId ? state.agentSessions.get(normalizedSessionId) : null;
  if (!entry) {
    throw createHttpError("agent session not found", {
      statusCode: 404,
      code: "agent_session_not_found",
      param: "sessionId",
    });
  }
  if (touch) {
    entry.lastActiveAt = state.now();
  }
  return { sessionId: normalizedSessionId, ...entry };
}

async function resolveAllowedInternalAgentBackend(requestedBackend, state) {
  const configured = await state.resolveConfiguredRuntimeBackend(requestedBackend, state.allowCliList, {
    configFilePath: state.configFilePath,
  });
  if (!configured?.runtimeBackend || configured.runtimeBackend !== requestedBackend) {
    throw createHttpError(`unknown model: ${requestedBackend}`, {
      statusCode: 404,
      code: "model_not_found",
      param: "backend",
    });
  }
  const commandLine = state.resolveAiSessionCommandLine(
    requestedBackend,
    state.allowCliList,
    state.runtimeEnv,
    requestedBackend,
  );
  return {
    requestedBackend,
    sessionBackend: configured.runtimeBackend,
    commandLine,
    sessionOptions: state.resolveAiSessionOptions(
      requestedBackend,
      state.allowCliList,
      state.runtimeEnv,
      requestedBackend,
    ),
  };
}

async function resolveRequestedBackend(model, state) {
  const requestedModel = String(model || state.defaultBackend || "").trim();
  if (!requestedModel) {
    throw createHttpError("model is required", {
      code: "missing_model",
      param: "model",
    });
  }

  const normalizedRequestedModel = normalizeRuntimeBackendName(requestedModel);
  const configured = await state.resolveConfiguredRuntimeBackend(normalizedRequestedModel, state.allowCliList, {
    configFilePath: state.configFilePath,
  });

  if (configured?.runtimeBackend) {
    const commandLine = state.resolveAiSessionCommandLine(
      normalizedRequestedModel,
      state.allowCliList,
      state.runtimeEnv,
      configured.runtimeBackend,
    );
    return {
      requestedModel,
      sessionBackend: configured.runtimeBackend,
      commandLine,
      sessionOptions: state.resolveAiSessionOptions(
        normalizedRequestedModel,
        state.allowCliList,
        state.runtimeEnv,
        configured.runtimeBackend,
      ),
    };
  }

  const normalizedBackend = await state.normalizeRuntimeBackendAlias(normalizedRequestedModel, {
    configFilePath: state.configFilePath,
  });
  const isSupported = await state.isRuntimeSupportedBackend(normalizedBackend, {
    configFilePath: state.configFilePath,
  });
  if (!isSupported) {
    throw createHttpError(`unknown model: ${requestedModel}`, {
      statusCode: 404,
      code: "model_not_found",
      param: "model",
    });
  }

  return {
    requestedModel,
    sessionBackend: normalizedBackend,
    commandLine: state.resolveAiSessionCommandLine(
      normalizedRequestedModel,
      state.allowCliList,
      state.runtimeEnv,
      normalizedBackend,
    ),
    sessionOptions: state.resolveAiSessionOptions(
      normalizedRequestedModel,
      state.allowCliList,
      state.runtimeEnv,
      normalizedBackend,
    ),
  };
}

async function handleModelsRequest(_req, res, state) {
  const advertised = await state.listAdvertisedBackends(state.allowCliList, {
    configFilePath: state.configFilePath,
  });
  const models = new Set(advertised.supportedBackends || []);
  if (state.defaultBackend) {
    models.add(state.defaultBackend);
  }
  sendJson(res, 200, {
    object: "list",
    data: [...models].sort().map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "conductor",
    })),
  });
}

async function handleChatCompletionsRequest(req, res, state) {
  const body = await readJsonBody(req, { maxBytes: state.requestBodyLimitBytes });
  if (body.stream === true) {
    sendOpenAiError(res, 400, "stream=true is not supported yet", {
      code: "unsupported_stream",
    });
    return;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    sendOpenAiError(res, 400, "tools are not supported yet", {
      code: "unsupported_tools",
      param: "tools",
    });
    return;
  }
  if (body.n !== undefined && Number(body.n) !== 1) {
    sendOpenAiError(res, 400, "only n=1 is supported", {
      code: "unsupported_n",
      param: "n",
    });
    return;
  }

  let responseFormat;
  let chatTurn;
  try {
    responseFormat = normalizeResponseFormat(body.response_format);
    chatTurn = buildChatTurn(body.messages);
  } catch (error) {
    throw createHttpError(error?.message || "invalid request", {
      code: "invalid_chat_request",
    });
  }
  const backend = await resolveRequestedBackend(body.model, state);
  let imageInputs;
  try {
    imageInputs = await state.materializeImageInputs(chatTurn.imageUrls, {
      fetchImpl: state.fetchImpl,
    });
  } catch (error) {
    throw createHttpError(error?.message || "failed to process image input", {
      code: "invalid_image_input",
      param: "messages",
    });
  }

  let session = null;
  try {
    session = state.createAiSession(backend.sessionBackend, {
      initialHistory: chatTurn.initialHistory,
      initialImages: imageInputs.files,
      cwd: state.cwd,
      configFile: state.configFilePath,
      env: state.runtimeEnv,
      ...(backend.sessionOptions || {}),
      ...(backend.commandLine ? { commandLine: backend.commandLine } : {}),
      ...(backend.sessionBackend === "codex" ? { ignoreCodexApiKey: true } : {}),
      ...(responseFormat.outputFormat ? { outputFormat: responseFormat.outputFormat } : {}),
      ...(responseFormat.jsonSchema ? { jsonSchema: responseFormat.jsonSchema, structuredOutput: true } : {}),
      logger: {
        log: (message) => {
          state.logger.log?.(`[serve-ai] ${message}`);
        },
      },
    });

    const rawResult = await session.runTurn(chatTurn.promptText, {
      useInitialImages: imageInputs.files.length > 0,
      ...(responseFormat.jsonSchema ? { jsonSchema: responseFormat.jsonSchema } : {}),
    });

    let result = rawResult;
    try {
      result = normalizeStructuredOutputResult(rawResult, responseFormat);
    } catch {
      throw createHttpError("backend did not return valid JSON for the requested response_format", {
        statusCode: 502,
        type: "server_error",
        code: "invalid_backend_json",
      });
    }

    sendJson(
      res,
      200,
      toOpenAiChatCompletion(result, {
        model: backend.requestedModel,
      }),
    );
  } finally {
    if (session && typeof session.close === "function") {
      await session.close().catch(() => {});
    }
    await imageInputs?.cleanup?.();
  }
}

async function handleAgentCreateRequest(req, res, state) {
  const body = await readJsonBody(req, { maxBytes: state.requestBodyLimitBytes });
  const requestedBackend = normalizeInternalAgentBackend(body.backend);
  const backend = await resolveAllowedInternalAgentBackend(requestedBackend, state);
  let releaseReservation = await reserveAgentSessionSlot(state);
  let session = null;
  let insertedSession = false;
  const requestOptions = sanitizeInternalAgentCreateOptions(body.options);
  try {
    session = state.createAgentSession(backend.sessionBackend, {
      ...(backend.sessionOptions || {}),
      ...requestOptions,
      cwd: state.cwd,
      configFile: state.configFilePath,
      env: state.runtimeEnv,
      ...(backend.commandLine ? { commandLine: backend.commandLine } : {}),
      ...(requestedBackend === "codex" ? { ignoreCodexApiKey: true } : {}),
      logger: {
        log: (message) => {
          state.logger.log?.(`[serve-ai] [agent] ${message}`);
        },
      },
    });

    const agentSessionId = randomUUID();
    state.agentSessions.set(agentSessionId, {
      backend: backend.sessionBackend,
      createdAt: state.now(),
      lastActiveAt: state.now(),
      activeRuns: 0,
      session,
    });
    insertedSession = true;
    releaseReservation();
    releaseReservation = null;

    const snapshot = typeof session.getSnapshot === "function" ? session.getSnapshot() : null;
    const sessionInfo = typeof session.getSessionInfo === "function" ? session.getSessionInfo() : null;
    sendJson(res, 200, {
      sessionId: agentSessionId,
      backend: backend.sessionBackend,
      requestedBackend: backend.requestedBackend,
      snapshot,
      sessionInfo,
    });
  } catch (error) {
    releaseReservation?.();
    if (!insertedSession) {
      await session?.close?.().catch(() => {});
    }
    throw error;
  }
}

async function handleAgentMethodRequest(req, res, state, agentSessionId) {
  const body = await readJsonBody(req, { maxBytes: state.requestBodyLimitBytes });
  const { sessionId, session } = getAgentSessionEntry(state, agentSessionId);
  const method = String(body.method || "").trim();
  const allowedMethods = new Set([
    "ensureSessionInfo",
    "getSessionInfo",
    "getSessionUsageSummary",
    "interruptCurrentTurn",
    "setSessionReplyTarget",
    "usesSessionFileReplyStream",
    "close",
  ]);
  if (!allowedMethods.has(method) || typeof session[method] !== "function") {
    throw createHttpError(`unsupported agent method: ${method}`, {
      statusCode: 400,
      code: "unsupported_agent_method",
      param: "method",
    });
  }

  const args = Array.isArray(body.args) ? body.args : [];
  const result = await session[method](...args);
  const snapshot = typeof session.getSnapshot === "function" ? session.getSnapshot() : null;
  if (method === "close") {
    state.agentSessions.delete(sessionId);
  }
  sendJson(res, 200, {
    result,
    snapshot,
  });
}

async function handleAgentRunTurnRequest(req, res, state, agentSessionId) {
  const body = await readJsonBody(req, { maxBytes: state.requestBodyLimitBytes });
  const entry = getAgentSessionEntry(state, agentSessionId);
  const { sessionId, session } = entry;
  const promptText = String(body.promptText || "");
  const runOptions = sanitizeInternalAgentRunOptions(body.options);
  const eventNames = ["session", "assistant_message", "working_status", "auth_required", "process.exited"];
  const listeners = [];
  let completed = false;
  let writeQueue = Promise.resolve();

  const enqueueNdjson = (payload) => {
    writeQueue = writeQueue.then(
      () => writeNdjson(res, payload),
      () => writeNdjson(res, payload),
    );
    return writeQueue;
  };

  const handleDisconnect = () => {
    if (completed) {
      return;
    }
    void closeAgentSession(state, sessionId, "client_disconnected");
  };

  sendNdjsonHeaders(res);
  res.once("close", handleDisconnect);
  for (const eventName of eventNames) {
    if (typeof session.on !== "function") {
      continue;
    }
    const listener = (payload) => {
      void enqueueNdjson({
        type: "event",
        name: eventName,
        payload,
      });
    };
    session.on(eventName, listener);
    listeners.push([eventName, listener]);
  }

  try {
    const trackedEntry = state.agentSessions.get(sessionId);
    if (trackedEntry) {
      trackedEntry.activeRuns += 1;
      trackedEntry.lastActiveAt = state.now();
    }
    const result = await session.runTurn(promptText, {
      ...runOptions,
      onProgress: async (payload) => {
        await enqueueNdjson({
          type: "progress",
          payload,
        });
      },
    });
    await enqueueNdjson({
      type: "result",
      result,
      snapshot: typeof session.getSnapshot === "function" ? session.getSnapshot() : null,
    });
  } catch (error) {
    await enqueueNdjson({
      type: "error",
      error: serializeInternalError(error),
    });
  } finally {
    await writeQueue.catch(() => {});
    completed = true;
    res.off("close", handleDisconnect);
    for (const [eventName, listener] of listeners) {
      session.off?.(eventName, listener);
    }
    const trackedEntry = state.agentSessions.get(sessionId);
    if (trackedEntry) {
      trackedEntry.activeRuns = Math.max(0, trackedEntry.activeRuns - 1);
      trackedEntry.lastActiveAt = state.now();
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

async function handleRequest(req, res, state) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  if (state.apiKey) {
    const providedKey = parseAuthorizationHeader(req.headers.authorization);
    if (!providedKey || providedKey !== state.apiKey) {
      sendOpenAiError(res, 401, "invalid api key", {
        type: "authentication_error",
        code: "invalid_api_key",
      });
      return;
    }
  }

  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/v1/models") {
    await handleModelsRequest(req, res, state);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/v1/chat/completions") {
    await handleChatCompletionsRequest(req, res, state);
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/internal/agent/sessions") {
    await handleAgentCreateRequest(req, res, state);
    return;
  }
  const agentRouteMatch = requestUrl.pathname.match(/^\/internal\/agent\/sessions\/([^/]+)\/(request|run-turn)$/);
  if (req.method === "POST" && agentRouteMatch) {
    const [, agentSessionId, action] = agentRouteMatch;
    if (action === "request") {
      await handleAgentMethodRequest(req, res, state, decodeURIComponent(agentSessionId));
      return;
    }
    await handleAgentRunTurnRequest(req, res, state, decodeURIComponent(agentSessionId));
    return;
  }

  sendOpenAiError(res, 404, `route not found: ${req.method || "GET"} ${requestUrl.pathname}`, {
    code: "not_found",
    type: "invalid_request_error",
  });
}

export async function startServeAiServer(options = {}, deps = {}) {
  const runtimeConfig = await (deps.loadServeAiRuntimeConfig || loadServeAiRuntimeConfig)(options.configFile);
  const defaults = runtimeConfig.defaults && typeof runtimeConfig.defaults === "object" ? runtimeConfig.defaults : {};
  const runtimeEnv = {
    ...process.env,
    ...(runtimeConfig.envs && typeof runtimeConfig.envs === "object" ? runtimeConfig.envs : {}),
  };
  const host = String(
    options.host || process.env.CONDUCTOR_SERVE_AI_HOST || defaults.host || DEFAULT_HOST,
  ).trim() || DEFAULT_HOST;
  const port = normalizePort(
    options.port ?? process.env.CONDUCTOR_SERVE_AI_PORT ?? defaults.port,
    DEFAULT_PORT,
  );
  const defaultBackend = String(options.backend || defaults.backend || "codex").trim();
  const apiKey = typeof options.apiKey === "string" && options.apiKey.trim()
    ? options.apiKey.trim()
    : typeof defaults.api_key === "string" && defaults.api_key.trim()
      ? defaults.api_key.trim()
      : "";
  const cwd =
    typeof options.cwd === "string" && options.cwd.trim()
      ? options.cwd.trim()
      : process.cwd();

  const state = {
    host,
    port,
    cwd,
    apiKey,
    defaultBackend,
    configFilePath: runtimeConfig.activeConfigPath,
    conductorConfigPath: runtimeConfig.conductorConfigPath,
    serveAiConfigPath: runtimeConfig.serveAiConfigPath,
    configSource: runtimeConfig.source,
    allowCliList: runtimeConfig.allowCliList,
    runtimeEnv,
    agentSessions: new Map(),
    agentSessionReservations: 0,
    agentSessionIdleTtlMs: normalizePositiveInt(
      options.agentSessionIdleTtlMs ?? process.env.CONDUCTOR_SERVE_AI_AGENT_IDLE_TTL_MS ?? defaults.agent_idle_ttl_ms,
      DEFAULT_AGENT_SESSION_IDLE_TTL_MS,
    ),
    agentSessionSweepIntervalMs: normalizePositiveInt(
      options.agentSessionSweepIntervalMs ?? process.env.CONDUCTOR_SERVE_AI_AGENT_SWEEP_INTERVAL_MS ?? defaults.agent_sweep_interval_ms,
      DEFAULT_AGENT_SESSION_SWEEP_INTERVAL_MS,
    ),
    agentSessionMaxCount: normalizePositiveInt(
      options.agentSessionMaxCount ?? process.env.CONDUCTOR_SERVE_AI_AGENT_MAX_SESSIONS ?? defaults.agent_max_sessions,
      DEFAULT_AGENT_SESSION_MAX_COUNT,
    ),
    agentSessionInterruptTimeoutMs: normalizePositiveInt(
      options.agentSessionInterruptTimeoutMs ??
        process.env.CONDUCTOR_SERVE_AI_AGENT_INTERRUPT_TIMEOUT_MS ??
        defaults.agent_interrupt_timeout_ms,
      DEFAULT_AGENT_SESSION_INTERRUPT_TIMEOUT_MS,
    ),
    requestBodyLimitBytes: normalizePositiveInt(options.requestBodyLimitBytes, DEFAULT_REQUEST_BODY_LIMIT),
    createAiSession: deps.createAiSession || createAiSession,
    createAgentSession:
      deps.createAgentSession ||
      ((backend, sessionOptions) => createInProcessAiSession(backend, sessionOptions, deps.createAiSession || createAiSession)),
    listAdvertisedBackends: deps.listAdvertisedBackends || listAdvertisedBackends,
    normalizeRuntimeBackendAlias: deps.normalizeRuntimeBackendAlias || normalizeRuntimeBackendAlias,
    resolveConfiguredRuntimeBackend: deps.resolveConfiguredRuntimeBackend || resolveConfiguredRuntimeBackend,
    isRuntimeSupportedBackend: deps.isRuntimeSupportedBackend || isRuntimeSupportedBackend,
    resolveAiSessionCommandLine: deps.resolveAiSessionCommandLine || resolveAiSessionCommandLine,
    resolveAiSessionOptions: deps.resolveAiSessionOptions || resolveAiSessionOptions,
    materializeImageInputs: deps.materializeImageInputs || materializeImageInputs,
    fetchImpl: deps.fetchImpl || fetch,
    logger: deps.logger || console,
    now: typeof deps.now === "function" ? deps.now : () => Date.now(),
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, state).catch((error) => {
      state.logger.error?.(`[serve-ai] request failed: ${error?.message || error}`);
      sendOpenAiError(
        res,
        Number(error?.statusCode) || 500,
        error?.message || "internal server error",
        {
          type: error?.openAiType || "server_error",
          code: error?.openAiCode || "internal_error",
          param: error?.openAiParam || null,
        },
      );
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const agentSessionSweeper = setInterval(() => {
    void sweepAgentSessions(state).catch((error) => {
      state.logger.error?.(`[serve-ai] agent session sweep failed: ${error?.message || error}`);
    });
  }, state.agentSessionSweepIntervalMs);
  if (typeof agentSessionSweeper.unref === "function") {
    agentSessionSweeper.unref();
  }

  const address = server.address();
  const resolvedPort =
    address && typeof address === "object" && typeof address.port === "number" ? address.port : port;
  return {
    server,
    host,
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    configPath: runtimeConfig.activeConfigPath,
    configSource: runtimeConfig.source,
    conductorConfigPath: runtimeConfig.conductorConfigPath,
    serveAiConfigPath: runtimeConfig.serveAiConfigPath,
    close: async () => {
      clearInterval(agentSessionSweeper);
      await Promise.allSettled(
        [...state.agentSessions.keys()].map((sessionId) => closeAgentSession(state, sessionId, "server_close")),
      );
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
