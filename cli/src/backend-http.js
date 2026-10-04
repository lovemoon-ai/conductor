/**
 * Thin authenticated JSON client for the web API routes the SDK does not wrap.
 *
 * The entity subcommands (`task`, `project`, `issue`, `daemon`, `settings`,
 * `search`, `auth`) mirror what the web frontend can do. Most of those routes
 * have no SDK method, and wrapping each one in `@love-moon/conductor-sdk` would
 * tie every new CLI verb to an SDK release. This helper talks to the same
 * `/api/...` routes the frontend calls, with the same Bearer token the SDK uses.
 *
 * Errors carry `statusCode` and `details` (the parsed error body), the same shape
 * as the SDK's `BackendApiError`, so `reportError` / `exitCodeForError` in
 * `entity-helpers.js` print the server's reason and map 401/403/404/400 to the
 * RFC exit codes without any per-command handling.
 */

import process from "node:process";

import { emitDryRun, loadConductorConfig, makeDryRunPayload } from "./entity-helpers.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class BackendHttpError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name = "BackendApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function baseUrlOf(config) {
  const raw = String(config?.backendUrl || "").trim().replace(/\/+$/, "");
  if (!raw) {
    throw new Error("Conductor backendUrl is not configured; run `conductor config` first");
  }
  // Every route lives under /api; tolerate a backendUrl that already ends in it.
  return raw.endsWith("/api") ? raw.slice(0, -4) : raw;
}

/** Build `/api/<segments>` with every dynamic segment URL-encoded. */
export function apiPath(...segments) {
  return `/api/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`;
}

function appendQuery(url, query) {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createBackendHttp({ config, fetchImpl, env = process.env }) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!doFetch) {
    throw new Error("Global fetch is not available; provide fetchImpl");
  }
  const base = baseUrlOf(config);

  function buildUrl(pathname, query) {
    const url = new URL(`${base}${pathname}`);
    appendQuery(url, query);
    return url.toString();
  }

  async function request(method, pathname, options = {}) {
    const url = buildUrl(pathname, options.query);
    const hasBody = options.body !== undefined;
    const launchedByDaemon = env?.CONDUCTOR_LAUNCHED_BY_DAEMON === "1";
    const headers = {
      Authorization: `Bearer ${config.agentToken}`,
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      // Same rule as the SDK: an agent launched by a daemon identifies itself so
      // agent-gated routes (scheduled messages) apply their agent policy.
      ...(options.agentActor && launchedByDaemon ? { "X-Conductor-Actor": "agent" } : {}),
      ...(options.headers || {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error?.name === "AbortError" ? "timed out" : (error?.message || String(error));
      throw new BackendHttpError(`Backend request failed: ${reason}`, undefined, undefined);
    } finally {
      clearTimeout(timer);
    }
    const payload = await readBody(response);
    if (!response.ok) {
      throw new BackendHttpError(`Backend responded with ${response.status}`, response.status, payload);
    }
    return payload;
  }

  /** POST a multipart `FormData` body (fetch sets the boundary header itself). */
  async function upload(pathname, formData, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    let response;
    try {
      response = await doFetch(buildUrl(pathname, options.query), {
        method: "POST",
        headers: { Authorization: `Bearer ${config.agentToken}`, Accept: "application/json" },
        body: formData,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error?.name === "AbortError" ? "timed out" : (error?.message || String(error));
      throw new BackendHttpError(`Upload failed: ${reason}`, undefined, undefined);
    } finally {
      clearTimeout(timer);
    }
    const payload = await readBody(response);
    if (!response.ok) {
      throw new BackendHttpError(`Backend responded with ${response.status}`, response.status, payload);
    }
    return payload;
  }

  /** Fetch a binary body (GET, or POST with `options.body` as JSON); resolves to the raw Response. */
  async function download(pathname, options = {}) {
    const hasBody = options.body !== undefined;
    let response;
    try {
      response = await doFetch(buildUrl(pathname, options.query), {
        method: hasBody ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${config.agentToken}`,
          Accept: "*/*",
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new BackendHttpError(`Download failed: ${error?.message || String(error)}`, undefined, undefined);
    }
    if (!response.ok) {
      throw new BackendHttpError(`Backend responded with ${response.status}`, response.status, await readBody(response));
    }
    return response;
  }

  return {
    baseUrl: base,
    url: buildUrl,
    request,
    upload,
    download,
    get: (pathname, options) => request("GET", pathname, options),
    post: (pathname, body, options = {}) => request("POST", pathname, { ...options, body }),
    put: (pathname, body, options = {}) => request("PUT", pathname, { ...options, body }),
    patch: (pathname, body, options = {}) => request("PATCH", pathname, { ...options, body }),
    delete: (pathname, options) => request("DELETE", pathname, options),
  };
}

/**
 * Resolve config the same way `buildApis` does (tests inject `deps.config` and
 * `deps.fetchImpl`) and return a client.
 */
export async function buildHttp(deps = {}) {
  const config = deps.config || (await loadConductorConfig(deps));
  return createBackendHttp({ config, fetchImpl: deps.fetchImpl, env: deps.env });
}

/**
 * Run a write request, or print it instead when `--dry-run` is set.
 * Returns `{ dryRun: true }` for a dry run, otherwise `{ dryRun: false, data }`.
 */
export async function sendOrPreview(http, argv, deps, method, pathname, body, options = {}) {
  if (argv.dryRun) {
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload(method, http.url(pathname, options.query), body, options.note ? { note: options.note } : {}),
    );
    return { dryRun: true, data: null };
  }
  const data = await http.request(method, pathname, { ...options, ...(body !== undefined ? { body } : {}) });
  return { dryRun: false, data };
}

/** Parse a JSON option value (object or array), raising an ARGS error on bad input. */
export function parseJsonOption(value, flag) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    const err = new Error(`${flag} must be valid JSON: ${error.message}`);
    err.code = "ARGS";
    throw err;
  }
}

export function argsError(message) {
  const err = new Error(message);
  err.code = "ARGS";
  return err;
}

/**
 * Map project id → display label ("name@daemon" when bound to a daemon), for
 * cross-project listings whose rows only carry a project id. Best effort: a
 * failed lookup falls back to showing ids.
 */
export async function projectLabels(http) {
  const labels = new Map();
  try {
    const list = await http.get(apiPath("projects"));
    const projects = Array.isArray(list) ? list : (Array.isArray(list?.projects) ? list.projects : []);
    for (const project of projects) {
      if (!project?.id) continue;
      const name = project.name ?? project.id;
      const host = project.daemonHost ?? project.daemon_host;
      labels.set(project.id, host ? `${name}@${host}` : name);
    }
  } catch {
    // Keep ids.
  }
  return labels;
}

/** Pad column widths to the longest cell so long UUIDs never break the table. */
export function formatTable(header, rows) {
  const widths = header.slice(0, -1).map((title, i) => Math.max(String(title).length, ...rows.map((row) => String(row[i] ?? "").length)));
  return [header, ...rows].map((row) => row
    .map((cell, i) => (i < widths.length ? String(cell ?? "").padEnd(widths[i]) : String(cell ?? "")))
    .join("  "));
}
