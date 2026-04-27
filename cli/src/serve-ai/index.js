import http from "node:http";
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
    requestBodyLimitBytes: normalizePositiveInt(options.requestBodyLimitBytes, DEFAULT_REQUEST_BODY_LIMIT),
    createAiSession: deps.createAiSession || createAiSession,
    listAdvertisedBackends: deps.listAdvertisedBackends || listAdvertisedBackends,
    normalizeRuntimeBackendAlias: deps.normalizeRuntimeBackendAlias || normalizeRuntimeBackendAlias,
    resolveConfiguredRuntimeBackend: deps.resolveConfiguredRuntimeBackend || resolveConfiguredRuntimeBackend,
    isRuntimeSupportedBackend: deps.isRuntimeSupportedBackend || isRuntimeSupportedBackend,
    resolveAiSessionCommandLine: deps.resolveAiSessionCommandLine || resolveAiSessionCommandLine,
    resolveAiSessionOptions: deps.resolveAiSessionOptions || resolveAiSessionOptions,
    materializeImageInputs: deps.materializeImageInputs || materializeImageInputs,
    fetchImpl: deps.fetchImpl || fetch,
    logger: deps.logger || console,
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
