/**
 * Shared version-check utilities used by both `conductor update` and the daemon auto-update flow.
 */

import http from "node:http";
import https from "node:https";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

export const PACKAGE_NAME = "@love-moon/conductor-cli";
const DEFAULT_UPDATE_WINDOW = { startMinutes: 120, endMinutes: 240 };
const REQUEST_TIMEOUT_MS = 10_000;

function resolveTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return REQUEST_TIMEOUT_MS;
}

/**
 * Fetch the latest published version from the npm registry.
 * Prefers `npm view` so local registry / proxy / CA config is respected,
 * then falls back to a direct registry request.
 * Returns the version string on success, or `null` on any failure.
 */
export async function fetchLatestVersion(packageName = PACKAGE_NAME, deps = {}) {
  const timeoutMs = resolveTimeoutMs(deps.timeoutMs);
  const npmVersion = getLatestVersionFromNpm(packageName, deps);
  if (npmVersion) {
    return npmVersion;
  }

  const registryBase = getRegistryBaseUrl(deps.registryUrl);
  const requestUrl = new URL(`${registryBase.replace(/\/$/, "")}/${encodeURIComponent(packageName)}/latest`);
  const requestImpl =
    requestUrl.protocol === "http:"
      ? (deps.httpGet || http.get)
      : (deps.httpsGet || https.get);

  return new Promise((resolve) => {
    const req = requestImpl(requestUrl, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.version || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function getLatestVersionFromNpm(packageName, deps = {}) {
  const execFileSyncFn = deps.execFileSync || execFileSync;
  const platform = deps.platform || process.platform;
  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  const timeoutMs = resolveTimeoutMs(deps.timeoutMs);

  try {
    const output = execFileSyncFn(
      npmCommand,
      ["view", packageName, "version", "--json"],
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed = JSON.parse(String(output).trim());
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
  } catch {
    return null;
  }
}

function getRegistryBaseUrl(overrideRegistryUrl) {
  const fromEnv = typeof process.env.npm_config_registry === "string"
    ? process.env.npm_config_registry.trim()
    : "";
  const candidate = String(overrideRegistryUrl || fromEnv || "https://registry.npmjs.org").trim();
  if (!candidate) {
    return "https://registry.npmjs.org";
  }
  return candidate;
}

/**
 * Compare two semver-like version strings.
 * Returns `true` when `latest` is strictly newer than `current`.
 */
export function isNewerVersion(latest, current) {
  const parse = (v) =>
    String(v || "")
      .replace(/^v/, "")
      .split(".")
      .map(Number);

  const latestParts = parse(latest);
  const currentParts = parse(current);

  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
    const l = latestParts[i] || 0;
    const c = currentParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

/**
 * Detect the package manager that was used to install the CLI globally.
 * Returns `"pnpm"`, `"yarn"`, or `"npm"` (default fallback).
 */
export function detectPackageManager(options = {}) {
  const hintSources = [options.launcherPath, options.packageRoot];
  for (const hint of hintSources) {
    const detected = detectPackageManagerFromHint(hint);
    if (detected) {
      return detected;
    }
  }

  try {
    const conductorPath = execSync("which conductor || where conductor", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    const detected = detectPackageManagerFromHint(conductorPath);
    if (detected) {
      return detected;
    }
  } catch {
    /* ignore */
  }

  try {
    execSync("pnpm --version", { stdio: "pipe" });
    return "pnpm";
  } catch {
    /* not available */
  }

  try {
    execSync("yarn --version", { stdio: "pipe" });
    return "yarn";
  } catch {
    /* not available */
  }

  return "npm";
}

function detectPackageManagerFromHint(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const normalized = path.resolve(value).toLowerCase().replace(/\\/g, "/");
  if (
    normalized.includes("/pnpm/") ||
    normalized.includes(".pnpm/") ||
    normalized.endsWith("/pnpm")
  ) {
    return "pnpm";
  }
  if (normalized.includes("/yarn/") || normalized.includes("/.yarn/")) {
    return "yarn";
  }
  if (normalized.includes("/node_modules/")) {
    return "npm";
  }
  return null;
}

/**
 * Parse an "HH:MM-HH:MM" window string into start/end minute-of-day values.
 * Falls back to 02:00-04:00 on invalid input.
 */
export function parseUpdateWindow(str) {
  const m = String(str || "").match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return { ...DEFAULT_UPDATE_WINDOW };
  const startHour = parseInt(m[1], 10);
  const startMinute = parseInt(m[2], 10);
  const endHour = parseInt(m[3], 10);
  const endMinute = parseInt(m[4], 10);
  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    return { ...DEFAULT_UPDATE_WINDOW };
  }
  return {
    startMinutes: startHour * 60 + startMinute,
    endMinutes: endHour * 60 + endMinute,
  };
}

/**
 * Auto-update should only mutate managed/global installs. Local repo runs and pnpm-linked
 * worktrees are treated as development installs and are skipped by default.
 */
export function isManagedInstallPath(packageRoot) {
  if (typeof packageRoot !== "string" || !packageRoot.trim()) {
    return false;
  }
  const normalized = path.resolve(packageRoot);
  return normalized.includes(`${path.sep}node_modules${path.sep}`);
}

/**
 * Check whether the current local time falls inside the given update window.
 * Handles windows that wrap around midnight (e.g. "23:00-05:00").
 */
export function isInUpdateWindow(window) {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  if (window.startMinutes <= window.endMinutes) {
    return current >= window.startMinutes && current < window.endMinutes;
  }
  // wraps midnight
  return current >= window.startMinutes || current < window.endMinutes;
}
