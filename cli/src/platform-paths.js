import os from "node:os";
import path from "node:path";

export function resolveHomeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function defaultConfigPath(env = process.env) {
  return path.join(resolveHomeDir(env), ".conductor", "config.yaml");
}

export function isPosixStylePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

export function dirnameForPath(value) {
  return isPosixStylePath(value) ? path.posix.dirname(value) : path.dirname(value);
}

export function joinForBasePath(basePath, ...parts) {
  return isPosixStylePath(basePath) ? path.posix.join(basePath, ...parts) : path.join(basePath, ...parts);
}

export function resolveForBasePath(basePath, ...parts) {
  return isPosixStylePath(basePath) ? path.posix.resolve(basePath, ...parts) : path.resolve(basePath, ...parts);
}

export function relativeForBasePath(basePath, targetPath) {
  return isPosixStylePath(basePath) || isPosixStylePath(targetPath)
    ? path.posix.relative(basePath, targetPath)
    : path.relative(basePath, targetPath);
}

export function isAbsolutePath(value) {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function resolveUserPath(value, {
  baseDir = process.cwd(),
  env = process.env,
} = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    return raw;
  }
  if (raw === "~") {
    return resolveHomeDir(env);
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(resolveHomeDir(env), raw.slice(2));
  }
  if (path.isAbsolute(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    return raw;
  }
  if (isPosixStylePath(baseDir)) {
    return path.posix.resolve(baseDir, raw);
  }
  return path.resolve(baseDir, raw);
}
