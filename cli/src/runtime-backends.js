import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import yaml from "js-yaml";
import { BUILT_IN_BACKENDS as AI_SDK_BUILT_IN_BACKENDS } from "@love-moon/ai-sdk";

// CLI display order for built-in backends. ai-sdk owns the canonical set of
// built-in backends; CLI just picks an ordering for "Supported Backends:" log
// output. The self-check below ensures this list always matches ai-sdk's set.
const BUILT_IN_RUNTIME_BACKENDS = ["codex", "claude", "kimi", "opencode", "copilot", "chat-web"];
const BUILT_IN_RUNTIME_BACKEND_SET = new Set(BUILT_IN_RUNTIME_BACKENDS);
// Backends that don't shell out to a CLI binary — they run in-process via
// the SDK and therefore don't need an `allow_cli_list` entry. `copilot`
// embeds the GitHub Copilot SDK; `chat-web` drives a Chromium browser via
// Playwright. For both, conductor-fire boots without any installed CLI.
const COMMAND_OPTIONAL_BUILT_IN_RUNTIME_BACKENDS = ["copilot", "chat-web"];
const COMMAND_OPTIONAL_BUILT_IN_RUNTIME_BACKEND_SET = new Set(COMMAND_OPTIONAL_BUILT_IN_RUNTIME_BACKENDS);

// Legacy aliases (e.g. "code" → "codex", "kimi-cli" → "kimi") are derived
// from ai-sdk's BUILT_IN_BACKENDS to avoid drift. ai-sdk is the single source
// of truth for which alias maps to which built-in backend.
const LEGACY_RUNTIME_BACKEND_ALIASES = new Set(
  AI_SDK_BUILT_IN_BACKENDS.flatMap((entry) =>
    entry.aliases.filter((alias) => alias !== entry.backend),
  ),
);

/**
 * Asserts that CLI's ordered built-in display list and ai-sdk's built-in
 * backend set are exactly equal. Throws on drift in either direction.
 *
 * Exported for test use; also invoked at module load below as a fail-fast
 * invariant check.
 *
 * @param {string[]}                                    cliBackends
 * @param {ReadonlyArray<{ backend: string }>}          aiSdkBackends
 */
export function assertCliAndAiSdkBackendsAgree(cliBackends, aiSdkBackends) {
  const aiSdkBackendSet = new Set(aiSdkBackends.map((entry) => entry.backend));
  const cliBackendSet = new Set(cliBackends);
  for (const backend of cliBackends) {
    if (!aiSdkBackendSet.has(backend)) {
      throw new Error(
        `cli/runtime-backends: BUILT_IN_RUNTIME_BACKENDS lists "${backend}" `
          + `but ai-sdk does not know about it. Did you remove it from ai-sdk's BUILT_IN_BACKENDS?`,
      );
    }
  }
  for (const backend of aiSdkBackendSet) {
    if (!cliBackendSet.has(backend)) {
      throw new Error(
        `cli/runtime-backends: ai-sdk has built-in backend "${backend}" `
          + `but BUILT_IN_RUNTIME_BACKENDS does not list it. Add it to BUILT_IN_RUNTIME_BACKENDS in cli/src/runtime-backends.js.`,
      );
    }
  }
}

// Module-load self-check: fails fast if someone adds a new built-in to ai-sdk
// without updating CLI's ordering, or vice versa.
assertCliAndAiSdkBackendsAgree(BUILT_IN_RUNTIME_BACKENDS, AI_SDK_BUILT_IN_BACKENDS);
const externalRuntimeCatalogPromises = new Map();
let externalRuntimeImportNonce = 0;

function appendProviderModulePaths(parts, value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendProviderModulePaths(parts, entry);
    }
    return;
  }
  const raw = String(value || "").trim();
  if (!raw) {
    return;
  }
  for (const item of splitProviderModulePathString(raw)) {
    const normalized = item.trim();
    if (normalized) {
      parts.push(normalized);
    }
  }
}

function looksLikeProviderModulePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("file:") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /\.[cm]?[jt]sx?$/i.test(normalized) ||
    /^[A-Za-z]:[\\/]/.test(normalized)
  );
}

function splitProviderModulePathString(raw) {
  const normalized = String(raw || "").trim();
  if (!normalized) {
    return [];
  }

  const platformParts = normalized
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  if (platformParts.length > 1 || !normalized.includes(",")) {
    return platformParts;
  }

  const commaParts = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (commaParts.length > 1 && commaParts.every(looksLikeProviderModulePath)) {
    return commaParts;
  }

  return platformParts;
}

function listProviderModulePaths(providerPathEnv) {
  const parts = [];
  appendProviderModulePaths(parts, providerPathEnv);
  return [...new Set(parts)];
}

function normalizeRuntimeBackendName(backend) {
  return String(backend || "").trim().toLowerCase();
}

function stripExecutableSuffix(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\.(cmd|bat|exe)$/i, "");
}

export function parseCommandParts(commandLine) {
  const input = String(commandLine || "").trim();
  if (!input) {
    return { command: "", args: [], parts: [] };
  }

  const parts = [];
  let current = "";
  let quote = "";
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const nextChar = input[index + 1];

    if (quote === "'") {
      if (char === "'") {
        quote = "";
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = "";
        continue;
      }
      if (char === "\\") {
        if (nextChar === "\"" || nextChar === "\\") {
          current += nextChar;
          tokenStarted = true;
          index += 1;
          continue;
        }
        current += "\\";
        tokenStarted = true;
        continue;
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (char === "\\") {
      if (nextChar && (/\s/.test(nextChar) || nextChar === "\"" || nextChar === "'" || nextChar === "\\")) {
        current += nextChar;
        tokenStarted = true;
        index += 1;
        continue;
      }
      current += "\\";
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

  if (quote) {
    throw new Error(`Invalid command line: unterminated ${quote === "\"" ? "double" : "single"} quote`);
  }

  if (tokenStarted) {
    parts.push(current);
  }

  return {
    command: parts[0] || "",
    args: parts.slice(1),
    parts,
  };
}

function isEnvironmentAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token || "").trim());
}

function collectExecutableCandidates(commandLine) {
  const { parts } = parseCommandParts(commandLine);
  if (!parts.length) {
    return [];
  }

  const candidates = [];
  const pushCandidate = (token) => {
    const executable = stripExecutableSuffix(path.basename(String(token || "").trim()));
    if (!executable || candidates.includes(executable)) {
      return;
    }
    candidates.push(executable);
  };

  const findFirstCommandTokenIndex = (startIndex, { skipEnvAssignments = false } = {}) => {
    for (let index = startIndex; index < parts.length; index += 1) {
      const token = String(parts[index] || "").trim();
      if (!token || token === "--") {
        continue;
      }
      if (skipEnvAssignments && isEnvironmentAssignment(token)) {
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
      return index;
    }
    return -1;
  };

  const walkCommand = (startIndex, { skipEnvAssignments = false } = {}) => {
    const tokenIndex = findFirstCommandTokenIndex(startIndex, { skipEnvAssignments });
    if (tokenIndex === -1) {
      return;
    }

    const token = parts[tokenIndex];
    pushCandidate(token);

    const executable = stripExecutableSuffix(path.basename(token));
    if (executable === "env") {
      walkCommand(tokenIndex + 1, { skipEnvAssignments: true });
      return;
    }

    if (executable === "npx" || executable === "pnpx" || executable === "bunx") {
      walkCommand(tokenIndex + 1);
      return;
    }

    if (executable === "pnpm" || executable === "yarn" || executable === "npm") {
      const subcommandIndex = findFirstCommandTokenIndex(tokenIndex + 1);
      if (subcommandIndex === -1) {
        return;
      }
      const normalizedSubcommand = stripExecutableSuffix(path.basename(parts[subcommandIndex]));
      if (normalizedSubcommand === "exec" || normalizedSubcommand === "dlx") {
        walkCommand(subcommandIndex + 1);
      }
    }
  };

  walkCommand(0);

  return candidates;
}

export function inferBuiltInRuntimeBackendFromCommand(commandLine) {
  const candidates = collectExecutableCandidates(commandLine);
  for (const executable of candidates) {
    if (BUILT_IN_RUNTIME_BACKEND_SET.has(executable)) {
      return executable;
    }
  }
  return "";
}

async function inferRuntimeBackendFromCommand(commandLine, options = {}) {
  const builtInBackend = inferBuiltInRuntimeBackendFromCommand(commandLine);
  if (builtInBackend) {
    return builtInBackend;
  }
  const candidates = collectExecutableCandidates(commandLine);
  for (const executable of candidates) {
    const resolvedBackend = await normalizeRuntimeBackendAlias(executable, options);
    if (await isRuntimeSupportedBackend(resolvedBackend, options)) {
      return resolvedBackend;
    }
  }
  return "";
}

export function isBuiltInRuntimeBackend(backend) {
  return BUILT_IN_RUNTIME_BACKEND_SET.has(normalizeRuntimeBackendName(backend));
}

export function isCommandOptionalBuiltInRuntimeBackend(backend) {
  return COMMAND_OPTIONAL_BUILT_IN_RUNTIME_BACKEND_SET.has(normalizeRuntimeBackendName(backend));
}

function readConfigEnvValue(configFilePath, key) {
  const targetPath =
    typeof configFilePath === "string" && configFilePath.trim()
      ? path.resolve(configFilePath.trim())
      : path.join(process.env.HOME || "", ".conductor", "config.yaml");
  try {
    if (!targetPath || !fs.existsSync(targetPath)) {
      return "";
    }
    const parsed = yaml.load(fs.readFileSync(targetPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return "";
    }
    return parsed?.envs?.[key];
  } catch {
    return undefined;
  }
}

function resolveProviderModulePaths(options = {}) {
  return [
    ...listProviderModulePaths(process.env.AISDK_PROVIDER_PATH),
    ...listProviderModulePaths(readConfigEnvValue(options.configFilePath, "AISDK_PROVIDER_PATH")),
  ].filter((value, index, array) => array.indexOf(value) === index);
}

function createEmptyExternalCatalog() {
  return {
    backends: [],
    backendSet: new Set(),
    aliasToBackend: new Map(),
    descriptors: [],
  };
}

function validateDescriptor(descriptor, sourcePath) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error(`External AI SDK provider module ${sourcePath} contains an invalid provider descriptor.`);
  }
  const backend = normalizeRuntimeBackendName(descriptor.backend);
  if (!backend) {
    throw new Error(`External AI SDK provider module ${sourcePath} is missing provider.backend.`);
  }
  if (BUILT_IN_RUNTIME_BACKEND_SET.has(backend)) {
    throw new Error(`External AI SDK provider backend "${backend}" from ${sourcePath} conflicts with a built-in backend.`);
  }
  if (LEGACY_RUNTIME_BACKEND_ALIASES.has(backend)) {
    throw new Error(`External AI SDK provider backend "${backend}" from ${sourcePath} conflicts with a reserved CLI alias.`);
  }
  const variant = String(descriptor.variant || "").trim();
  if (!variant) {
    throw new Error(`External AI SDK provider "${backend}" from ${sourcePath} is missing provider.variant.`);
  }
  if (typeof descriptor.createSession !== "function") {
    throw new Error(`External AI SDK provider "${backend}" from ${sourcePath} is missing provider.createSession().`);
  }
  const aliases = Array.isArray(descriptor.aliases)
    ? descriptor.aliases.map((item) => normalizeRuntimeBackendName(item)).filter(Boolean)
    : [];
  return {
    backend,
    aliases,
    resolveResumeContext: typeof descriptor.resolveResumeContext === "function" ? descriptor.resolveResumeContext : null,
  };
}

async function importExternalProviderModule(modulePath) {
  const resolvedPath = path.isAbsolute(modulePath) ? modulePath : path.resolve(modulePath);
  const moduleUrl = pathToFileURL(resolvedPath);
  moduleUrl.searchParams.set("conductor-external-provider-attempt", String(++externalRuntimeImportNonce));
  return import(moduleUrl.href);
}

function registerExternalAlias(catalog, alias, backend, sourcePath) {
  if (!alias) {
    return;
  }
  if (BUILT_IN_RUNTIME_BACKEND_SET.has(alias)) {
    throw new Error(`External AI SDK provider alias "${alias}" from ${sourcePath} conflicts with a built-in backend.`);
  }
  if (LEGACY_RUNTIME_BACKEND_ALIASES.has(alias)) {
    throw new Error(`External AI SDK provider alias "${alias}" from ${sourcePath} conflicts with a reserved CLI alias.`);
  }
  const existingBackend = catalog.aliasToBackend.get(alias);
  if (existingBackend && existingBackend !== backend) {
    throw new Error(
      `External AI SDK provider alias "${alias}" from ${sourcePath} conflicts with backend "${existingBackend}".`,
    );
  }
  catalog.aliasToBackend.set(alias, backend);
}

function formatExternalProviderLoadError(modulePath, error) {
  const message = error?.message || String(error);
  return [
    `Failed to load external AI SDK provider module ${modulePath}: ${message}`,
    "Help: if this provider comes from a local repo or workspace, did you forget to run pnpm install?",
  ].join(" ");
}

async function loadExternalRuntimeCatalog(providerPathEnv) {
  const catalog = createEmptyExternalCatalog();
  for (const modulePath of listProviderModulePaths(providerPathEnv)) {
    let importedModule;
    try {
      importedModule = await importExternalProviderModule(modulePath);
    } catch (error) {
      throw new Error(formatExternalProviderLoadError(modulePath, error));
    }
    const providers = Array.isArray(importedModule?.providers) ? importedModule.providers : [];
    if (providers.length === 0) {
      throw new Error(`External AI SDK provider module ${modulePath} must export a non-empty providers array.`);
    }
    for (const rawDescriptor of providers) {
      const descriptor = validateDescriptor(rawDescriptor, modulePath);
      if (catalog.backendSet.has(descriptor.backend)) {
        throw new Error(
          `External AI SDK provider backend "${descriptor.backend}" is declared more than once (latest: ${modulePath}).`,
        );
      }
      catalog.descriptors.push(descriptor);
      catalog.backends.push(descriptor.backend);
      catalog.backendSet.add(descriptor.backend);
      registerExternalAlias(catalog, descriptor.backend, descriptor.backend, modulePath);
      for (const alias of descriptor.aliases) {
        registerExternalAlias(catalog, alias, descriptor.backend, modulePath);
      }
    }
  }
  return catalog;
}

async function getExternalRuntimeCatalog(options = {}) {
  const modulePaths = resolveProviderModulePaths(options);
  const cacheKey = modulePaths.join("\0");
  if (!externalRuntimeCatalogPromises.has(cacheKey)) {
    const loadPromise = loadExternalRuntimeCatalog(modulePaths).catch((error) => {
      externalRuntimeCatalogPromises.delete(cacheKey);
      throw error;
    });
    externalRuntimeCatalogPromises.set(cacheKey, loadPromise);
  }
  return externalRuntimeCatalogPromises.get(cacheKey);
}

export async function normalizeRuntimeBackendAlias(backend, options = {}) {
  const normalized = normalizeRuntimeBackendName(backend);
  if (!normalized) {
    return "";
  }
  if (LEGACY_RUNTIME_BACKEND_ALIASES.has(normalized) || BUILT_IN_RUNTIME_BACKEND_SET.has(normalized)) {
    return normalized;
  }
  const catalog = await getExternalRuntimeCatalog(options);
  return catalog.aliasToBackend.get(normalized) || normalized;
}

export async function listRuntimeSupportedBackends(options = {}) {
  const catalog = await getExternalRuntimeCatalog(options);
  return [...BUILT_IN_RUNTIME_BACKENDS, ...catalog.backends];
}

export async function getExternalRuntimeBackendDescriptor(backend, options = {}) {
  const normalized = await normalizeRuntimeBackendAlias(backend, options);
  if (!normalized || BUILT_IN_RUNTIME_BACKEND_SET.has(normalized) || LEGACY_RUNTIME_BACKEND_ALIASES.has(normalized)) {
    return null;
  }
  const catalog = await getExternalRuntimeCatalog(options);
  return catalog.backendSet.has(normalized)
    ? {
        backend: normalized,
        ...(catalog.descriptors.find((descriptor) => descriptor.backend === normalized) || {}),
      }
    : null;
}

export async function isRuntimeSupportedBackend(backend, options = {}) {
  const normalized = await normalizeRuntimeBackendAlias(backend, options);
  if (BUILT_IN_RUNTIME_BACKEND_SET.has(normalized)) {
    return true;
  }
  if (LEGACY_RUNTIME_BACKEND_ALIASES.has(normalized)) {
    return false;
  }
  const catalog = await getExternalRuntimeCatalog(options);
  return catalog.backendSet.has(normalized);
}

export async function filterRuntimeSupportedAllowCliList(allowCliList, options = {}) {
  if (!allowCliList || typeof allowCliList !== "object") {
    return {};
  }
  const filtered = {};
  for (const [backend, command] of Object.entries(allowCliList)) {
    const normalizedBackend = normalizeRuntimeBackendName(backend);
    if (!normalizedBackend || LEGACY_RUNTIME_BACKEND_ALIASES.has(normalizedBackend)) {
      continue;
    }
    if (typeof command !== "string" || !command.trim()) {
      continue;
    }
    if (filtered[normalizedBackend] !== undefined) {
      continue;
    }
    try {
      const inferredRuntimeBackend = await inferRuntimeBackendFromCommand(command, options);
      if (inferredRuntimeBackend) {
        filtered[normalizedBackend] = command.trim();
        continue;
      }
    } catch {
      // Ignore external provider discovery failures here so built-in aliases inferred from
      // the command line can still pass through independently.
    }
    try {
      const resolvedBackend = await normalizeRuntimeBackendAlias(normalizedBackend, options);
      const isSupportedResolvedBackend = await isRuntimeSupportedBackend(resolvedBackend, options);
      if (!isSupportedResolvedBackend) {
        continue;
      }
      filtered[normalizedBackend] = command.trim();
    } catch {
      // Skip broken external entries here; callers that actually need external backends
      // can surface discovery failures from the advertised-backend path.
    }
  }
  return filtered;
}

export async function resolveConfiguredRuntimeBackend(backend, allowCliList, options = {}) {
  const normalizedBackend = normalizeRuntimeBackendName(backend);
  if (!normalizedBackend || LEGACY_RUNTIME_BACKEND_ALIASES.has(normalizedBackend)) {
    return null;
  }

  const configuredCommand =
    allowCliList && typeof allowCliList === "object" && typeof allowCliList[normalizedBackend] === "string"
      ? allowCliList[normalizedBackend].trim()
      : "";
  const hasConfiguredEntry = Boolean(configuredCommand);
  if (hasConfiguredEntry) {
    const inferredRuntimeBackend = await inferRuntimeBackendFromCommand(configuredCommand, options);
    if (inferredRuntimeBackend) {
      return {
        requestedBackend: normalizedBackend,
        runtimeBackend: inferredRuntimeBackend,
        commandLine: configuredCommand,
      };
    }
  }
  const resolvedBackend = await normalizeRuntimeBackendAlias(normalizedBackend, options);
  if (hasConfiguredEntry && await isRuntimeSupportedBackend(resolvedBackend, options)) {
    return {
      requestedBackend: normalizedBackend,
      runtimeBackend: resolvedBackend,
      commandLine: configuredCommand,
    };
  }

  if (!hasConfiguredEntry && isCommandOptionalBuiltInRuntimeBackend(resolvedBackend)) {
    return {
      requestedBackend: normalizedBackend,
      runtimeBackend: resolvedBackend,
      commandLine: "",
    };
  }

  if (!hasConfiguredEntry && !isBuiltInRuntimeBackend(resolvedBackend) && await isRuntimeSupportedBackend(resolvedBackend, options)) {
    return {
      requestedBackend: normalizedBackend,
      runtimeBackend: resolvedBackend,
      commandLine: "",
    };
  }
  return null;
}

export async function listAdvertisedBackends(allowCliList, options = {}) {
  const filteredAllowCliList =
    allowCliList && typeof allowCliList === "object"
      ? Object.fromEntries(
          Object.entries(allowCliList)
            .map(([backend, command]) => [normalizeRuntimeBackendName(backend), typeof command === "string" ? command.trim() : ""])
            .filter(([backend, command]) => backend && command),
        )
      : {};
  const configuredBackends = Object.keys(filteredAllowCliList);
  let runtimeBackends = [...BUILT_IN_RUNTIME_BACKENDS];
  let discoveryError = null;
  try {
    runtimeBackends = await listRuntimeSupportedBackends(options);
  } catch (error) {
    discoveryError = error;
  }
  const discoveredExternalBackends = runtimeBackends.filter((backend) => !BUILT_IN_RUNTIME_BACKEND_SET.has(backend));
  const advertisedConfiguredBackends = [];
  const runtimeBackendMap = {};

  for (const backend of configuredBackends) {
    try {
      const configuredBackend = await resolveConfiguredRuntimeBackend(backend, filteredAllowCliList, options);
      if (!configuredBackend?.runtimeBackend) {
        continue;
      }
      advertisedConfiguredBackends.push(backend);
      runtimeBackendMap[backend] = configuredBackend.runtimeBackend;
    } catch (error) {
      discoveryError ||= error;
    }
  }

  const explicitlyConfiguredBackends = new Set(advertisedConfiguredBackends);
  const shadowedExternalBackends = new Set();

  for (const backend of advertisedConfiguredBackends) {
    const runtimeBackend = runtimeBackendMap[backend] || "";
    if (
      !runtimeBackend ||
      isBuiltInRuntimeBackend(runtimeBackend) ||
      runtimeBackend === backend ||
      explicitlyConfiguredBackends.has(runtimeBackend)
    ) {
      continue;
    }
    shadowedExternalBackends.add(runtimeBackend);
  }

  const externalBackends = discoveredExternalBackends.filter(
    (backend) => !shadowedExternalBackends.has(backend) && !explicitlyConfiguredBackends.has(backend),
  );

  for (const backend of externalBackends) {
    runtimeBackendMap[backend] = backend;
  }

  const commandOptionalBuiltIns = BUILT_IN_RUNTIME_BACKENDS.filter(
    (backend) => isCommandOptionalBuiltInRuntimeBackend(backend) && !runtimeBackendMap[backend],
  );
  for (const backend of commandOptionalBuiltIns) {
    runtimeBackendMap[backend] = backend;
  }

  const supportedBackends = [
    ...new Set([...advertisedConfiguredBackends, ...externalBackends, ...commandOptionalBuiltIns]),
  ];

  return {
    configuredBackends: advertisedConfiguredBackends,
    externalBackends,
    supportedBackends,
    runtimeBackendMap,
    discoveryError,
  };
}

export { BUILT_IN_RUNTIME_BACKENDS as RUNTIME_SUPPORTED_BACKENDS, normalizeRuntimeBackendName };

export function resetRuntimeBackendCacheForTests() {
  externalRuntimeCatalogPromises.clear();
}
