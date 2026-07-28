/**
 * Shared helpers for the entity-oriented subcommands (project / issue / task).
 *
 * Responsibilities:
 *   - Load the Conductor config file (delegate to conductor-sdk's loadConfig).
 *   - Resolve the active project via the SDK ProjectsApi.resolveProject().
 *   - Build write-request metadata with `actor: "cli"` audit fields.
 *   - Print --json or human-friendly output and translate errors into
 *     RFC-defined exit codes.
 *
 * The CLI deliberately does *not* statically import the SDK Api classes — they
 * may not exist in the published SDK at the time this file is loaded. We
 * dynamically import them so older SDKs still allow `conductor --help`, and
 * tests can inject stub Api classes via the `deps` parameter.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { envForExplicitConfigFile } from "./config-env.js";
import { resolveConductorConfigPath } from "./conductor-paths.js";

// RFC §4 exit codes
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  ARGS: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  PROJECT_UNRESOLVED: 5,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, "..");

let cachedPkgVersion = null;
export function getCliVersion() {
  if (cachedPkgVersion !== null) {
    return cachedPkgVersion;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
    cachedPkgVersion = pkg.version || "0.0.0";
  } catch {
    cachedPkgVersion = "0.0.0";
  }
  return cachedPkgVersion;
}

export function resolveConfigPath(configFile, env = process.env) {
  return resolveConductorConfigPath(configFile, env);
}

/**
 * Load the Conductor config; tolerate missing files when env credentials are
 * present (useful for tests). Returns the same shape `loadConfig` does
 * (`{ agentToken, backendUrl }` at minimum).
 */
export async function loadConductorConfig(options = {}) {
  const env = options.env || process.env;
  const configFile = options.configFile;
  const sdk = await loadSdk(options);

  const configPath = resolveConfigPath(configFile, env);
  const configEnv = envForExplicitConfigFile(configFile, env);
  if (fs.existsSync(configPath)) {
    return sdk.loadConfig(configPath, { env: configEnv });
  }

  const agentToken = typeof env.CONDUCTOR_AGENT_TOKEN === "string" ? env.CONDUCTOR_AGENT_TOKEN.trim() : "";
  const backendUrl = typeof env.CONDUCTOR_BACKEND_URL === "string" ? env.CONDUCTOR_BACKEND_URL.trim() : "";
  if (agentToken && backendUrl) {
    if (sdk.ConductorConfig) {
      return new sdk.ConductorConfig({ agentToken, backendUrl });
    }
    return { agentToken, backendUrl };
  }

  // Let the SDK raise a typed not-found error.
  return sdk.loadConfig(configPath, { env: configEnv });
}

/**
 * Dynamic import of the SDK so the CLI can boot even if the SDK lacks the
 * new ProjectsApi/IssuesApi/TasksApi exports yet (Agent A is implementing
 * those in parallel). Tests can override the loader via `deps.sdk`.
 */
export async function loadSdk(options = {}) {
  if (options.sdk) {
    return options.sdk;
  }
  return import("@love-moon/conductor-sdk");
}

/**
 * Build the API surface (Projects / Issues / Tasks) on top of a single
 * BackendApiClient. The Api classes come from the SDK; tests inject stubs.
 */
export async function buildApis(options = {}) {
  const sdk = await loadSdk(options);
  const config = options.config || (await loadConductorConfig(options));
  const fetchImpl = options.fetchImpl;
  const ApiClient = sdk.BackendApiClient;
  const apiClient = options.backendApi
    ?? (ApiClient ? new ApiClient(config, fetchImpl ? { fetchImpl } : {}) : null);

  if (!apiClient) {
    throw new Error("BackendApiClient is unavailable from @love-moon/conductor-sdk");
  }

  const ProjectsApi = sdk.ProjectsApi;
  const IssuesApi = sdk.IssuesApi;
  const TasksApi = sdk.TasksApi;

  return {
    sdk,
    config,
    apiClient,
    projects: ProjectsApi ? new ProjectsApi(apiClient) : null,
    issues: IssuesApi ? new IssuesApi(apiClient) : null,
    tasks: TasksApi ? new TasksApi(apiClient) : null,
  };
}

/**
 * Build the metadata blob for a CLI write request.
 *
 * Audit fields live under `metadata.audit` (RFC 0025 §5.2 + review M3/H1) so
 * they can't be silently overridden by `--metadata-json '{"actor":"system"}'`
 * top-level injections — the server strips top-level audit-shaped keys before
 * persisting and only trusts what's inside the `audit` object.
 *
 * Merge order:
 *   - Caller's free-form metadata (`extraMetadata`) flows through verbatim
 *     except for any `audit` key, which is split out.
 *   - Caller's `audit` keys (if explicitly passed) are layered UNDER the CLI
 *     stamp (`actor: "cli"`, `cliVersion`, `invokedBy`) — i.e., the CLI value
 *     wins for keys it cares about, but a caller can still add extra audit
 *     fields (e.g., `audit.session: "abc123"`) without conflict.
 */
export function buildAuditMetadata(env = process.env, extraMetadata = {}) {
  const invokedBy = typeof env.CONDUCTOR_INVOKED_BY === "string" && env.CONDUCTOR_INVOKED_BY.trim()
    ? env.CONDUCTOR_INVOKED_BY.trim()
    : null;
  const cliAudit = {
    actor: "cli",
    cliVersion: getCliVersion(),
    invokedBy,
  };
  const safeExtra =
    extraMetadata && typeof extraMetadata === "object" && !Array.isArray(extraMetadata)
      ? { ...extraMetadata }
      : {};
  const callerAuditRaw = safeExtra.audit;
  delete safeExtra.audit;
  const callerAudit =
    callerAuditRaw && typeof callerAuditRaw === "object" && !Array.isArray(callerAuditRaw)
      ? callerAuditRaw
      : {};
  const audit = { ...callerAudit, ...cliAudit };
  return { ...safeExtra, audit };
}

/**
 * Errors translated into RFC §4 exit codes.
 */
export function exitCodeForError(err) {
  if (!err) return EXIT.GENERIC;
  const name = err.name || "";
  if (name === "ProjectNotResolvedError" || err.code === "PROJECT_UNRESOLVED") {
    return EXIT.PROJECT_UNRESOLVED;
  }
  const status = err.statusCode ?? err.status ?? null;
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 400 || err.code === "ARGS") return EXIT.ARGS;
  return EXIT.GENERIC;
}

/**
 * Resolve the project per the precedence in RFC §2:
 *   1. explicit --project flag
 *   2. CONDUCTOR_PROJECT_ID env var
 *   3. cwd matching (delegated to SDK)
 *   4. user defaultProject
 * Returns whatever ProjectsApi.resolveProject returns ({ id, name, ... }).
 */
export async function resolveProject(apis, options = {}) {
  if (!apis.projects || typeof apis.projects.resolveProject !== "function") {
    throw new Error("ProjectsApi.resolveProject is not available in conductor-sdk");
  }
  const explicitProject = String(options.project ?? "").trim();
  if (explicitProject) {
    if (typeof apis.projects.getProject !== "function") {
      throw new Error("ProjectsApi.getProject is not available in conductor-sdk");
    }
    return apis.projects.getProject(explicitProject);
  }
  return apis.projects.resolveProject({
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
  });
}

/**
 * Human-printable string for an entity (project/issue/task summary).
 */
export function pad(value, width) {
  const text = String(value ?? "");
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

export function printJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function printPretty(stream, text) {
  stream.write(`${text}\n`);
}

export function readMessageInput({ positional, fromFile, useStdin, stdin }) {
  const sources = [
    positional !== undefined && positional !== "" ? "positional" : null,
    fromFile ? "from-file" : null,
    useStdin ? "stdin" : null,
  ].filter(Boolean);
  if (sources.length > 1) {
    const err = new Error(`Provide only one of: positional message, --from-file, --stdin (got ${sources.join(", ")})`);
    err.code = "ARGS";
    throw err;
  }
  if (positional !== undefined && positional !== "") {
    return String(positional);
  }
  if (fromFile) {
    return fs.readFileSync(path.resolve(fromFile), "utf8");
  }
  if (useStdin) {
    return readAllStdinSync(stdin || process.stdin);
  }
  const err = new Error("Empty message: pass a positional message, --from-file FILE, or --stdin");
  err.code = "ARGS";
  throw err;
}

function readAllStdinSync(stdin) {
  // For tests we accept a string fixture or a Buffer/Readable handler shim.
  if (typeof stdin === "string") return stdin;
  if (stdin && Buffer.isBuffer(stdin)) return stdin.toString("utf8");
  // Synchronous fallback using fs.readFileSync('/dev/stdin') style.
  try {
    const data = fs.readFileSync(0);
    return data.toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve a description from --description, --description-file, --description-stdin
 * (mutually exclusive). Returns undefined if none provided.
 */
export function readDescription({ description, descriptionFile, descriptionStdin, stdin }) {
  const sources = [
    typeof description === "string" && description !== "" ? "description" : null,
    descriptionFile ? "description-file" : null,
    descriptionStdin ? "description-stdin" : null,
  ].filter(Boolean);
  if (sources.length > 1) {
    const err = new Error(`Provide only one of: --description, --description-file, --description-stdin (got ${sources.join(", ")})`);
    err.code = "ARGS";
    throw err;
  }
  if (typeof description === "string" && description !== "") {
    return description;
  }
  if (descriptionFile) {
    return fs.readFileSync(path.resolve(descriptionFile), "utf8");
  }
  if (descriptionStdin) {
    return readAllStdinSync(stdin || process.stdin);
  }
  return undefined;
}

/**
 * Resolve `--evidence` either as inline text or `@file/path`.
 */
export function readEvidence(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const str = String(value);
  if (str.startsWith("@")) {
    const filePath = str.slice(1);
    return fs.readFileSync(path.resolve(filePath), "utf8");
  }
  return str;
}

/**
 * Format the dry-run preview. Always returns a JSON-serializable object so
 * callers can route through --json or render a human-friendly summary.
 *
 * Optional `note` lets callers flag preview imperfections — e.g. paths that
 * round-trip server metadata (`issue done --evidence`) where the live PATCH
 * body will merge existing keys the dry-run can't see (review L-NEW-2).
 */
export function makeDryRunPayload(method, url, body, options = {}) {
  const payload = {
    dryRun: true,
    request: {
      method,
      url,
      body,
    },
  };
  if (options.note) {
    payload.note = options.note;
  }
  return payload;
}

export function emitDryRun(stream, json, payload) {
  if (json) {
    printJson(stream, payload);
    return;
  }
  printPretty(stream, "[dry-run] would send:");
  printPretty(stream, `  ${payload.request.method} ${payload.request.url}`);
  if (payload.request.body !== undefined) {
    printPretty(stream, `  body: ${JSON.stringify(payload.request.body)}`);
  }
  if (payload.note) {
    printPretty(stream, `  note: ${payload.note}`);
  }
}

/**
 * Pull a human-readable reason out of a backend error payload. Backend routes
 * respond with `{ error }` (occasionally `{ message }`), which the SDK attaches
 * to BackendApiError.details. Surfacing it turns an opaque "Backend responded
 * with 409" into the actual cause (e.g. "Project daemon X is offline").
 */
function backendErrorDetail(error) {
  const details = error && typeof error === "object" ? error.details : null;
  if (!details) return null;
  if (typeof details === "string") return details.trim() || null;
  if (typeof details === "object") {
    const reason = details.error ?? details.message;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
  }
  return null;
}

/**
 * Translate an unknown error into a printable + exit-coded form.
 */
export function reportError(consoleErr, error) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = backendErrorDetail(error);
  const line = detail && detail !== message ? `${message}: ${detail}` : message;
  consoleErr.error(`Error: ${line}`);
  return exitCodeForError(error);
}
