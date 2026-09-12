/**
 * Shared plumbing for the `conductor remote` subcommands.
 *
 * `exec` and `cp` talk to the same backend, authenticate with the same token,
 * resolve the same config file and report failures the same way, so all of that
 * lives here rather than being copied per verb.
 */

import fs from "node:fs";
import process from "node:process";

import { ConductorConfig, loadConfig } from "@love-moon/conductor-sdk";
import { envForExplicitConfigFile } from "../config-env.js";
import { resolveConductorConfigPath } from "../conductor-paths.js";

/**
 * Following ssh: the remote command's exit code is passed through verbatim
 * (0-254) and 255 is reserved for this CLI's own failures. Reusing 1/2/4 for
 * local errors would make `grep` finding nothing (1) or `ls` on a missing path
 * (2) indistinguishable from a network error or a usage mistake.
 */
export const EXIT = { OK: 0, CLI_ERROR: 255 };

export class UsageError extends Error {}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Accepts `500ms`, `30s`, `2m`, or a bare number of seconds. */
export function parseTimeoutMs(value, defaultMs) {
  if (value === undefined || value === null || value === "") {
    return defaultMs;
  }
  const raw = String(value).trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) {
    throw new UsageError(`invalid --timeout value: ${value}`);
  }
  const amount = Number.parseFloat(match[1]);
  const unit = match[2] || "s";
  const multiplier = unit === "ms" ? 1 : unit === "m" ? 60_000 : 1_000;
  const ms = Math.round(amount * multiplier);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError(`invalid --timeout value: ${value}`);
  }
  return ms;
}

export function loadCliConfig(configFile, env = process.env) {
  const configPath = resolveConductorConfigPath(configFile, env);
  const configEnv = envForExplicitConfigFile(configFile, env);
  if (fs.existsSync(configPath)) {
    return loadConfig(configPath, { env: configEnv });
  }

  const agentToken = typeof env.CONDUCTOR_AGENT_TOKEN === "string" ? env.CONDUCTOR_AGENT_TOKEN.trim() : "";
  const backendUrl = typeof env.CONDUCTOR_BACKEND_URL === "string" ? env.CONDUCTOR_BACKEND_URL.trim() : "";
  if (agentToken && backendUrl) {
    return new ConductorConfig({ agentToken, backendUrl });
  }

  return loadConfig(configPath, { env: configEnv });
}

function authHeaders(config) {
  return { Authorization: `Bearer ${config.agentToken}` };
}

async function toApiError(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const message = payload?.error || text.trim() || `HTTP ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  // A 409 on a chunked upload means "wrong offset, here is the real one".
  // Carrying it on the error is what lets the caller resync instead of failing.
  if (typeof payload?.receivedBytes === "number") {
    error.receivedBytes = payload.receivedBytes;
  }
  return error;
}

/**
 * Whether a failed request is worth retrying.
 *
 * Network-level failures have no `status` at all; those are the blips resume
 * exists for. Among HTTP statuses only 5xx and 429 can plausibly succeed on a
 * second try — retrying a 403 or a 413 just wastes the user's time.
 */
export function isRetryable(error) {
  const status = error?.status;
  if (status === undefined || status === null) return true;
  return status >= 500 || status === 429;
}

/**
 * Retry `fn` on transient failures, handing it the attempt number. `retryable`
 * narrows what counts as transient: a caller whose request is not idempotent
 * (starting a command) must not retry a 5xx that may already have taken effect.
 */
export async function withRetry(fn, {
  attempts = 4, baseDelayMs = 500, sleep = delay, retryable = isRetryable,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      // An aborted transfer is the caller's own deadline firing, not a blip.
      if (error?.name === "AbortError" || !retryable(error)) throw error;
      if (attempt === attempts - 1) break;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function callApi(config, method, pathname, body, fetchImpl) {
  const url = new URL(pathname, config.backendUrl);
  const response = await fetchImpl(url.toString(), {
    method,
    headers: {
      ...authHeaders(config),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error || text.trim() || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/**
 * Stream a body up to the backend. Kept separate from `callApi` because the
 * body is a stream, not JSON: buffering a multi-hundred-MB file just to reuse
 * one helper would defeat the point of the whole transfer design.
 */
export async function putStream(config, pathname, stream, {
  sizeBytes, fetchImpl, signal, contentRange,
}) {
  const url = new URL(pathname, config.backendUrl);
  const response = await fetchImpl(url.toString(), {
    method: "PUT",
    headers: {
      ...authHeaders(config),
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      ...(Number.isFinite(sizeBytes) ? { "Content-Length": String(sizeBytes) } : {}),
      ...(contentRange ? { "Content-Range": contentRange } : {}),
    },
    body: stream,
    // Node's fetch requires this for a streaming request body.
    duplex: "half",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Open a streaming download. The caller owns consuming `response.body`. */
export async function getStream(config, pathname, { fetchImpl, signal, rangeFrom }) {
  const url = new URL(pathname, config.backendUrl);
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      ...authHeaders(config),
      Accept: "application/octet-stream",
      ...(rangeFrom > 0 ? { Range: `bytes=${rangeFrom}-` } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  // 416 is not a failure here: it means the local `.part` is already at or past
  // the full size, so there is nothing left to fetch.
  if (!response.ok && response.status !== 416) {
    throw await toApiError(response);
  }
  return response;
}
