export function createOpenAiErrorBody(message, { type = "invalid_request_error", param = null, code = null } = {}) {
  return {
    error: {
      message: String(message || "Unknown error"),
      type,
      param,
      code,
    },
  };
}

export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extraHeaders,
  });
  res.end(body);
}

export function sendOpenAiError(res, statusCode, message, options = {}) {
  sendJson(res, statusCode, createOpenAiErrorBody(message, options));
}
