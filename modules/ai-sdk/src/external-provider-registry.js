import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvConfig } from "./shared.js";

const BUILT_IN_BACKENDS = new Set(["codex", "claude", "kimi", "opencode"]);

const registryPromises = new Map();
let externalProviderImportNonce = 0;

function normalizeProviderPathEnv(value) {
  return String(value || "").trim();
}

function listProviderModulePathsFromValue(rawValue) {
  const raw = normalizeProviderPathEnv(rawValue);
  if (!raw) {
    return [];
  }
  const parts = raw
    .split(process.platform === "win32" ? ";" : ":")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function resolveProviderPathEnv(options = {}) {
  const envValue = normalizeProviderPathEnv(process.env.AISDK_PROVIDER_PATH);
  if (envValue) {
    return envValue;
  }
  const envConfig = loadEnvConfig(options.configFile);
  return normalizeProviderPathEnv(envConfig?.AISDK_PROVIDER_PATH);
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function createRegistry() {
  return {
    descriptors: [],
    byBackend: new Map(),
    aliasToBackend: new Map(),
  };
}

function registerAlias(registry, alias, backend, sourcePath) {
  const normalizedAlias = normalizeName(alias);
  if (!normalizedAlias) {
    return;
  }
  if (BUILT_IN_BACKENDS.has(normalizedAlias) && normalizedAlias !== backend) {
    throw new Error(
      `External AI SDK provider alias "${normalizedAlias}" from ${sourcePath} conflicts with built-in backend "${normalizedAlias}".`,
    );
  }
  const existingBackend = registry.aliasToBackend.get(normalizedAlias);
  if (existingBackend && existingBackend !== backend) {
    throw new Error(
      `External AI SDK provider alias "${normalizedAlias}" from ${sourcePath} conflicts with backend "${existingBackend}".`,
    );
  }
  registry.aliasToBackend.set(normalizedAlias, backend);
}

function validateDescriptor(descriptor, sourcePath) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error(`External AI SDK provider module ${sourcePath} contains an invalid provider descriptor.`);
  }
  const backend = normalizeName(descriptor.backend);
  if (!backend) {
    throw new Error(`External AI SDK provider module ${sourcePath} is missing provider.backend.`);
  }
  if (BUILT_IN_BACKENDS.has(backend)) {
    throw new Error(
      `External AI SDK provider backend "${backend}" from ${sourcePath} conflicts with a built-in backend.`,
    );
  }
  const variant = String(descriptor.variant || "").trim();
  if (!variant) {
    throw new Error(`External AI SDK provider "${backend}" from ${sourcePath} is missing provider.variant.`);
  }
  if (typeof descriptor.createSession !== "function") {
    throw new Error(`External AI SDK provider "${backend}" from ${sourcePath} is missing provider.createSession().`);
  }
  const aliases = Array.isArray(descriptor.aliases) ? descriptor.aliases.map((item) => normalizeName(item)).filter(Boolean) : [];
  return {
    backend,
    variant,
    aliases,
    createSession: descriptor.createSession,
    isSupported: typeof descriptor.isSupported === "function" ? descriptor.isSupported : null,
    sourcePath,
  };
}

async function loadRegistry(modulePaths) {
  const registry = createRegistry();
  for (const modulePath of modulePaths) {
    let importedModule;
    try {
      const resolvedPath = path.isAbsolute(modulePath) ? modulePath : path.resolve(modulePath);
      const moduleUrl = pathToFileURL(resolvedPath);
      moduleUrl.searchParams.set("conductor-ai-sdk-provider-attempt", String(++externalProviderImportNonce));
      importedModule = await import(moduleUrl.href);
    } catch (error) {
      throw new Error(`Failed to load external AI SDK provider module ${modulePath}: ${error?.message || error}`);
    }
    const providers = Array.isArray(importedModule?.providers) ? importedModule.providers : [];
    if (providers.length === 0) {
      throw new Error(`External AI SDK provider module ${modulePath} must export a non-empty providers array.`);
    }
    for (const rawDescriptor of providers) {
      const descriptor = validateDescriptor(rawDescriptor, modulePath);
      if (registry.byBackend.has(descriptor.backend)) {
        throw new Error(
          `External AI SDK provider backend "${descriptor.backend}" is declared more than once (latest: ${modulePath}).`,
        );
      }
      registry.descriptors.push(descriptor);
      registry.byBackend.set(descriptor.backend, descriptor);
      registerAlias(registry, descriptor.backend, descriptor.backend, modulePath);
      for (const alias of descriptor.aliases) {
        registerAlias(registry, alias, descriptor.backend, modulePath);
      }
    }
  }
  return registry;
}

export async function getExternalProviderRegistry(options = {}) {
  const providerPathEnv = resolveProviderPathEnv(options);
  if (!registryPromises.has(providerPathEnv)) {
    const loadPromise = loadRegistry(listProviderModulePathsFromValue(providerPathEnv)).catch((error) => {
      registryPromises.delete(providerPathEnv);
      throw error;
    });
    registryPromises.set(providerPathEnv, loadPromise);
  }
  return registryPromises.get(providerPathEnv);
}

export async function resolveExternalBackend(backend, options = {}) {
  const normalized = normalizeName(backend);
  if (!normalized) {
    return "";
  }
  const registry = await getExternalProviderRegistry(options);
  return registry.aliasToBackend.get(normalized) || normalized;
}

export async function getExternalProviderDescriptor(backend, options = {}) {
  const normalized = normalizeName(backend);
  if (!normalized) {
    return null;
  }
  const registry = await getExternalProviderRegistry(options);
  const resolvedBackend = registry.aliasToBackend.get(normalized) || normalized;
  return registry.byBackend.get(resolvedBackend) || null;
}

export function resetExternalProviderRegistryForTests() {
  registryPromises.clear();
}
