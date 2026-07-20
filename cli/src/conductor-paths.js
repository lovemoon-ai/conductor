import os from "node:os";
import path from "node:path";

export const CONDUCTOR_HOME_ENV_VAR = "CONDUCTOR_HOME";
export const CONDUCTOR_CONFIG_ENV_VAR = "CONDUCTOR_CONFIG";

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function resolveUserHome(env = process.env, fallbackHome = os.homedir()) {
  return (
    normalizeOptionalString(env?.HOME) ||
    normalizeOptionalString(env?.USERPROFILE) ||
    normalizeOptionalString(fallbackHome) ||
    "/tmp"
  );
}

export function resolveHomeRelativePath(value, env = process.env, fallbackHome = os.homedir()) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return "";
  }
  const userHome = resolveUserHome(env, fallbackHome);
  if (normalized === "~") {
    return path.resolve(userHome);
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.resolve(userHome, normalized.slice(2));
  }
  return path.resolve(normalized);
}

export function resolveConductorHome(env = process.env, options = {}) {
  const configuredHome = normalizeOptionalString(env?.[CONDUCTOR_HOME_ENV_VAR]);
  if (configuredHome) {
    return resolveHomeRelativePath(configuredHome, env, options.fallbackHome);
  }
  const userHome = normalizeOptionalString(options.userHome) || resolveUserHome(env, options.fallbackHome);
  return path.join(path.resolve(userHome), ".conductor");
}

export function resolveConductorConfigPath(configFile, env = process.env, options = {}) {
  const explicitPath = normalizeOptionalString(configFile);
  if (explicitPath) {
    return resolveHomeRelativePath(explicitPath, env, options.fallbackHome);
  }
  const configuredPath = normalizeOptionalString(env?.[CONDUCTOR_CONFIG_ENV_VAR]);
  if (configuredPath) {
    return resolveHomeRelativePath(configuredPath, env, options.fallbackHome);
  }
  return path.join(resolveConductorHome(env, options), "config.yaml");
}

export function materializeConductorPathEnv(configFile, env = process.env, options = {}) {
  return {
    CONDUCTOR_HOME: resolveConductorHome(env, options),
    CONDUCTOR_CONFIG: resolveConductorConfigPath(configFile, env, options),
  };
}
