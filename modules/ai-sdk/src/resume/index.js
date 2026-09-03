import {
  BUILT_IN_BACKENDS,
  getBuiltInBackendEntry,
  normalizeBuiltInBackend,
} from "../built-in-backends.js";
import {
  getExternalProviderDescriptor,
  resolveExternalBackend,
} from "../external-provider-registry.js";

import * as chatWeb from "./chat-web.js";
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import * as copilot from "./copilot.js";
import * as dsh from "./dsh.js";
import * as kimi from "./kimi.js";
import * as opencode from "./opencode.js";
import {
  buildResumeContext,
  isExistingDirectory,
  normalizeBackend,
  normalizeProjectPathCandidate,
  normalizeSessionId,
  resolveSessionRunDirectory,
} from "./shared.js";

/**
 * Map of canonical built-in backend name → resume module.
 *
 * **Every built-in backend MUST be registered here.** Resume is a required
 * capability for every provider in ai-sdk; the invariant is enforced by the
 * module-load self-check below.
 *
 * Adding a new built-in backend:
 *   1. Add an entry to {@link BUILT_IN_BACKENDS} in `../built-in-backends.js`.
 *   2. Create `./<backend>.js` exporting
 *      `{ BACKEND, buildCliArgs, findSessionPath, resolveResumeContext }`.
 *   3. Register the new module in this map.
 */
const RESUME_MODULES_BY_BACKEND = new Map([
  ["codex", codex],
  ["claude", claude],
  ["copilot", copilot],
  ["kimi", kimi],
  ["opencode", opencode],
  ["chat-web", chatWeb],
  ["dsh", dsh],
]);

// Sanity-check at module load:
// (1) Every registered resume module must point at a real built-in backend.
//     Catches typos like registering "kimii" by mistake.
// (2) Every built-in backend must have a registered resume module.
//     Enforces the "all providers support resume" invariant — a new backend
//     cannot be added to BUILT_IN_BACKENDS without its resume module.
for (const backend of RESUME_MODULES_BY_BACKEND.keys()) {
  if (!getBuiltInBackendEntry(backend)) {
    throw new Error(
      `ai-sdk resume dispatcher references unknown built-in backend "${backend}". `
        + `Did you forget to add it to BUILT_IN_BACKENDS in src/built-in-backends.js?`,
    );
  }
}
for (const entry of BUILT_IN_BACKENDS) {
  if (!RESUME_MODULES_BY_BACKEND.has(entry.backend)) {
    throw new Error(
      `ai-sdk built-in backend "${entry.backend}" has no resume module registered. `
        + `Resume is required for every built-in backend. Add src/resume/${entry.backend}.js and `
        + `register it in RESUME_MODULES_BY_BACKEND in src/resume/index.js.`,
    );
  }
}

function lookupBuiltInProvider(backend) {
  const canonical = normalizeBuiltInBackend(normalizeBackend(backend));
  return RESUME_MODULES_BY_BACKEND.get(canonical) || null;
}

export function resumeProviderForBackend(backend) {
  const provider = lookupBuiltInProvider(backend);
  return provider ? provider.BACKEND : null;
}

export function buildResumeArgsForBackend(backend, sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  const provider = lookupBuiltInProvider(backend);
  if (!provider) {
    throw new Error(`--resume is not supported for backend "${backend}"`);
  }
  return provider.buildCliArgs(normalizedSessionId);
}

export async function findSessionPath(provider, sessionId, options = {}) {
  const descriptor = lookupBuiltInProvider(provider);
  if (!descriptor) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return descriptor.findSessionPath(sessionId, options);
}

export { resolveSessionRunDirectory };

/**
 * Lists local sessions for a backend (aliases resolve like every other resume
 * entry point). Backends without a `listSessions` implementation yield [].
 */
export async function listSessionsForBackend(backendType, opts = {}) {
  const provider = lookupBuiltInProvider(backendType);
  if (!provider || typeof provider.listSessions !== "function") {
    return [];
  }
  return provider.listSessions(opts);
}

export async function resolveResumeContext(backend, sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const builtInProvider = lookupBuiltInProvider(backend);
  if (builtInProvider) {
    return builtInProvider.resolveResumeContext(normalizedSessionId, options);
  }

  const externalContext = await resolveExternalResumeContext(backend, normalizedSessionId, options);
  if (externalContext) {
    return externalContext;
  }
  throw new Error(`--resume is not supported for backend "${backend}"`);
}

async function resolveExternalResumeContext(backend, sessionId, options = {}) {
  const normalizedBackend = await resolveExternalBackend(normalizeBackend(backend), options);
  if (!normalizedBackend) {
    return null;
  }
  const descriptor = await getExternalProviderDescriptor(normalizedBackend, options);
  if (!descriptor) {
    return null;
  }
  if (typeof descriptor.resolveResumeContext !== "function") {
    return null;
  }
  const resolvedContext = await descriptor.resolveResumeContext(sessionId, options);
  if (!resolvedContext) {
    return null;
  }
  const cwd = normalizeProjectPathCandidate(resolvedContext?.cwd);
  if (!cwd) {
    throw new Error(`Could not resolve workspace for backend "${normalizedBackend}" session ${sessionId}`);
  }
  if (!(await isExistingDirectory(cwd))) {
    throw new Error(`Resume workspace path does not exist: ${cwd}`);
  }
  const sessionPath = normalizeProjectPathCandidate(resolvedContext?.sessionPath);
  const cwdSource =
    typeof resolvedContext?.debugMetadata?.cwdSource === "string"
      && resolvedContext.debugMetadata.cwdSource.trim()
      ? resolvedContext.debugMetadata.cwdSource.trim()
      : "provider";
  return buildResumeContext({
    provider: normalizedBackend,
    sessionId,
    sessionPath,
    cwd,
    cwdSource,
    extraDebug:
      resolvedContext?.debugMetadata && typeof resolvedContext.debugMetadata === "object"
        ? resolvedContext.debugMetadata
        : {},
  });
}

export async function inspectResumeTarget(backend, sessionId, options = {}) {
  return resolveResumeContext(backend, sessionId, options);
}

export { BUILT_IN_BACKENDS };
