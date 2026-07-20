import fs from "node:fs/promises";
import path from "node:path";

import { buildUpgradeCommand, fetchLatestVersion, isNewerVersion } from "./version-check.js";
import { resolveConductorHome } from "./conductor-paths.js";

export const DEFAULT_VERSION_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_VERSION_NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 800;
const DEFAULT_CACHE_FILE = "version-check.json";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function parseBooleanLike(value) {
  if (typeof value !== "string") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function isTimestampOlderThan(value, ageMs, nowMs) {
  const parsed = value ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed)) {
    return true;
  }
  return nowMs - parsed >= ageMs;
}

export function resolveVersionCheckCachePath(options = {}) {
  const env = options.env || process.env;
  const conductorHome = options.conductorHome
    ? path.resolve(options.conductorHome)
    : options.homeDir
      ? resolveConductorHome({}, { userHome: options.homeDir })
      : resolveConductorHome(env);
  return path.join(conductorHome, DEFAULT_CACHE_FILE);
}

export function normalizeVersionCheckCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const latestVersion = normalizeOptionalString(value.latestVersion);
  const lastNotifiedVersion = normalizeOptionalString(value.lastNotifiedVersion);
  const normalized = {
    lastCheckedAt: parseTimestamp(value.lastCheckedAt),
    latestVersion,
    latestCheckedAt: parseTimestamp(value.latestCheckedAt),
    lastNotifiedVersion,
    lastNotifiedAt: parseTimestamp(value.lastNotifiedAt),
  };
  if (
    !normalized.lastCheckedAt &&
    !normalized.latestVersion &&
    !normalized.latestCheckedAt &&
    !normalized.lastNotifiedVersion &&
    !normalized.lastNotifiedAt
  ) {
    return null;
  }
  return normalized;
}

export async function readVersionCheckCache(options = {}) {
  const readFileFn = options.readFile || fs.readFile;
  const cachePath = options.cachePath || resolveVersionCheckCachePath(options);
  try {
    const content = await readFileFn(cachePath, "utf8");
    return normalizeVersionCheckCache(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function writeVersionCheckCache(cache, options = {}) {
  const writeFileFn = options.writeFile || fs.writeFile;
  const mkdirFn = options.mkdir || fs.mkdir;
  const cachePath = options.cachePath || resolveVersionCheckCachePath(options);
  await mkdirFn(path.dirname(cachePath), { recursive: true });
  await writeFileFn(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

export function shouldSkipVersionCheck(options = {}) {
  const env = options.env || process.env;
  const subcommand = normalizeOptionalString(options.subcommand);
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout?.isTTY);

  if (parseBooleanLike(env.CONDUCTOR_SKIP_UPDATE_CHECK)) {
    return { skip: true, reason: "disabled_by_env" };
  }
  if (subcommand === "update") {
    return { skip: true, reason: "update_subcommand" };
  }
  if (!stdoutIsTTY) {
    return { skip: true, reason: "non_tty" };
  }
  if (parseBooleanLike(env.CI)) {
    return { skip: true, reason: "ci" };
  }
  if (normalizeOptionalString(env.CONDUCTOR_CLI_COMMAND)) {
    return { skip: true, reason: "nested_cli" };
  }
  return { skip: false, reason: null };
}

export function buildUpdateNotice({ currentVersion, latestVersion, installMethod, env }) {
  const noticeEnv =
    installMethod && !env?.CONDUCTOR_INSTALL_METHOD
      ? { ...env, CONDUCTOR_INSTALL_METHOD: installMethod }
      : env;
  const upgradeCommand = buildUpgradeCommand({ env: noticeEnv });
  return `New conductor version available: ${currentVersion} -> ${latestVersion}. Run: ${upgradeCommand}`;
}

function shouldNotifyVersion({ latestVersion, currentVersion, cache, nowMs, notifyIntervalMs }) {
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
    return false;
  }
  if (!cache?.lastNotifiedVersion || cache.lastNotifiedVersion !== latestVersion) {
    return true;
  }
  return isTimestampOlderThan(cache.lastNotifiedAt, notifyIntervalMs, nowMs);
}

function shouldRefreshVersion({ cache, nowMs, checkIntervalMs }) {
  if (!cache?.lastCheckedAt) {
    return true;
  }
  return isTimestampOlderThan(cache.lastCheckedAt, checkIntervalMs, nowMs);
}

function createUpdatedCache(previousCache, updates = {}) {
  return normalizeVersionCheckCache({
    ...previousCache,
    ...updates,
  });
}

export async function maybeCheckForUpdates(options = {}) {
  const env = options.env || process.env;
  const currentVersion = normalizeOptionalString(options.currentVersion);
  const subcommand = normalizeOptionalString(options.subcommand);
  const installMethod = normalizeOptionalString(env.CONDUCTOR_INSTALL_METHOD);
  const nowMs = options.nowMs ?? Date.now();
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_VERSION_CHECK_INTERVAL_MS;
  const notifyIntervalMs = options.notifyIntervalMs ?? DEFAULT_VERSION_NOTIFY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;
  const skip = shouldSkipVersionCheck({
    env,
    subcommand,
    stdoutIsTTY: options.stdoutIsTTY,
  });

  if (skip.skip || !currentVersion) {
    return { skipped: true, reason: skip.reason || "missing_current_version" };
  }

  const writeNotice = options.writeNotice || ((message) => process.stderr.write(`${message}\n`));
  const fetchLatestVersionFn = options.fetchLatestVersion || fetchLatestVersion;
  const cacheOptions = {
    cachePath: options.cachePath,
    conductorHome: options.conductorHome,
    homeDir: options.homeDir,
    env,
    readFile: options.readFile,
    writeFile: options.writeFile,
    mkdir: options.mkdir,
  };

  let cache = await readVersionCheckCache(cacheOptions);
  const needsRefresh = shouldRefreshVersion({ cache, nowMs, checkIntervalMs });

  if (!needsRefresh) {
    if (cache?.latestVersion && shouldNotifyVersion({
      latestVersion: cache.latestVersion,
      currentVersion,
      cache,
      nowMs,
      notifyIntervalMs,
    })) {
      writeNotice(buildUpdateNotice({
        currentVersion,
        latestVersion: cache.latestVersion,
        installMethod,
        env,
      }));
      cache = createUpdatedCache(cache, {
        lastNotifiedVersion: cache.latestVersion,
        lastNotifiedAt: new Date(nowMs).toISOString(),
      });
      if (cache) {
        await writeVersionCheckCache(cache, cacheOptions);
      }
    }
    return { skipped: false, refreshed: false, latestVersion: cache?.latestVersion || null };
  }

  let latestVersion = null;
  try {
    latestVersion = await fetchLatestVersionFn(undefined, { timeoutMs });
  } catch {
    latestVersion = null;
  }

  cache = createUpdatedCache(cache, {
    lastCheckedAt: new Date(nowMs).toISOString(),
    ...(latestVersion
      ? {
          latestVersion,
          latestCheckedAt: new Date(nowMs).toISOString(),
        }
      : {}),
  });

  if (cache) {
    await writeVersionCheckCache(cache, cacheOptions);
  }

  const versionToNotify = latestVersion || cache?.latestVersion || null;
  if (versionToNotify && shouldNotifyVersion({
    latestVersion: versionToNotify,
    currentVersion,
    cache,
    nowMs,
    notifyIntervalMs,
  })) {
      writeNotice(buildUpdateNotice({
        currentVersion,
        latestVersion: versionToNotify,
        installMethod,
        env,
      }));
    cache = createUpdatedCache(cache, {
      lastNotifiedVersion: versionToNotify,
      lastNotifiedAt: new Date(nowMs).toISOString(),
    });
    if (cache) {
      await writeVersionCheckCache(cache, cacheOptions);
    }
  }

  return {
    skipped: false,
    refreshed: true,
    latestVersion,
  };
}
