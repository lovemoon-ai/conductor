import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import yaml from "js-yaml";

const BUILT_IN_RUNTIME_BACKENDS = ["codex", "claude", "kimi", "opencode"];
const BUILT_IN_RUNTIME_BACKEND_SET = new Set(BUILT_IN_RUNTIME_BACKENDS);
const LEGACY_RUNTIME_BACKEND_ALIASES = new Set([
  "code",
  "claude-code",
  "open-code",
  "open_code",
  "kimi-cli",
  "kimi-code",
]);
const externalRuntimeCatalogPromises = new Map();
let externalRuntimeImportNonce = 0;

function normalizeProviderPathEnv(value) {
  return String(value || "").trim();
}

function listProviderModulePaths(providerPathEnv) {
  const raw = normalizeProviderPathEnv(providerPathEnv);
  if (!raw) {
    return [];
  }
  return [...new Set(raw.split(process.platform === "win32" ? ";" : ":").map((item) => item.trim()).filter(Boolean))];
}

function normalizeRuntimeBackendName(backend) {
  return String(backend || "").trim().toLowerCase();
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
    const value = parsed?.envs?.[key];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function resolveProviderPathEnv(options = {}) {
  return (
    normalizeProviderPathEnv(process.env.AISDK_PROVIDER_PATH) ||
    normalizeProviderPathEnv(readConfigEnvValue(options.configFilePath, "AISDK_PROVIDER_PATH"))
  );
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

async function loadExternalRuntimeCatalog(providerPathEnv) {
  const catalog = createEmptyExternalCatalog();
  for (const modulePath of listProviderModulePaths(providerPathEnv)) {
    let importedModule;
    try {
      importedModule = await importExternalProviderModule(modulePath);
    } catch (error) {
      throw new Error(`Failed to load external AI SDK provider module ${modulePath}: ${error?.message || error}`);
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
  const providerPathEnv = resolveProviderPathEnv(options);
  if (!externalRuntimeCatalogPromises.has(providerPathEnv)) {
    const loadPromise = loadExternalRuntimeCatalog(providerPathEnv).catch((error) => {
      externalRuntimeCatalogPromises.delete(providerPathEnv);
      throw error;
    });
    externalRuntimeCatalogPromises.set(providerPathEnv, loadPromise);
  }
  return externalRuntimeCatalogPromises.get(providerPathEnv);
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
    const normalizedBackend = await normalizeRuntimeBackendAlias(backend, options);
    if (!(await isRuntimeSupportedBackend(normalizedBackend, options))) {
      continue;
    }
    if (typeof command !== "string" || !command.trim()) {
      continue;
    }
    if (filtered[normalizedBackend] !== undefined) {
      continue;
    }
    filtered[normalizedBackend] = command.trim();
  }
  return filtered;
}

export { BUILT_IN_RUNTIME_BACKENDS as RUNTIME_SUPPORTED_BACKENDS, normalizeRuntimeBackendName };

export function resetRuntimeBackendCacheForTests() {
  externalRuntimeCatalogPromises.clear();
}
