import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import dotenv from "dotenv";
import yaml from "js-yaml";

import {
  ConductorWebSocketClient,
  ConductorConfig,
  loadConfig,
  ConfigFileNotFound,
  ProjectContext,
} from "@love-moon/conductor-sdk";
import { DaemonLogCollector } from "./log-collector.js";
import { createAiManagerHandlers, handleAiManagerRequest } from "./ai-manager-handlers.js";
import { resolveResumeContext } from "./fire/resume.js";
import {
  filterRuntimeSupportedAllowCliList,
  listAdvertisedBackends,
  resolveConfiguredRuntimeBackend,
  isBuiltInRuntimeBackend,
  isRuntimeSupportedBackend,
  normalizeRuntimeBackendAlias,
  normalizeRuntimeBackendName,
} from "./runtime-backends.js";
import {
  PACKAGE_NAME,
  buildUpgradeCommand,
  fetchLatestVersion,
  isNewerVersion,
  detectPackageManager,
  parseUpdateWindow,
  isInUpdateWindow,
  isManagedInstallPath,
  resolveInstallMethod,
} from "./version-check.js";
import {
  ensurePnpmOnlyBuiltDependencies,
  repairAndVerifyGlobalNodePty,
} from "./native-deps.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.join(__dirname, "..");
const DEFAULT_AI_BRIDGE_API_SPECIFIER = "@love-moon/ai-bridge/dist/api.js";
const moduleRequire = createRequire(import.meta.url);
const CLI_PATH = path.resolve(PACKAGE_ROOT, "bin", "conductor-fire.js");
const DAEMON_LOG_DIR = path.join(os.homedir(), ".conductor", "logs");
const DAEMON_LOG_PATH = path.join(DAEMON_LOG_DIR, "conductor-daemon.log");
const CLI_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")).version;
  } catch {
    return "unknown";
  }
})();
const PLAN_LIMIT_MESSAGES = {
  manual_fire_active_task: "Free plan limit reached: only 1 active fire task is allowed.",
  app_active_task: "Free plan limit reached: only 1 active app task is allowed.",
  daemon_active_connection: "Free plan limit reached: only 1 active daemon connection is allowed.",
};
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 40;
const DEFAULT_TERMINAL_RING_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERMINAL_RESUME_SNAPSHOT_MAX_BYTES = 128 * 1024;
const DEFAULT_RTC_MODULE_CANDIDATES = ["@roamhq/wrtc", "wrtc"];
const BLOCKING_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
let nodePtySpawnPromise = null;

function resolveNodePtySpawnExport(mod) {
  if (typeof mod?.spawn === "function") {
    return mod.spawn;
  }
  if (mod?.default && typeof mod.default.spawn === "function") {
    return mod.default.spawn.bind(mod.default);
  }
  throw new Error("node-pty spawn export not found");
}

export function probePtyTaskCapability({
  requireFn = moduleRequire,
  ensureSpawnHelperExecutableFn = ensureNodePtySpawnHelperExecutable,
} = {}) {
  try {
    const spawnHelperInfo = ensureSpawnHelperExecutableFn();
    const spawnPty = resolveNodePtySpawnExport(requireFn("node-pty"));
    return {
      enabled: true,
      reason: null,
      spawnHelperInfo,
      spawnPty,
    };
  } catch (error) {
    return {
      enabled: false,
      reason: error instanceof Error ? error.message : String(error),
      spawnHelperInfo: null,
      spawnPty: null,
    };
  }
}

function appendDaemonLog(line) {
  try {
    fs.mkdirSync(DAEMON_LOG_DIR, { recursive: true });
    fs.appendFileSync(DAEMON_LOG_PATH, line);
  } catch {
    // ignore file log errors
  }
}

function log(message) {
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
  const line = `[conductor-daemon ${ts}] ${message}\n`;
  process.stdout.write(line);
  appendDaemonLog(line);
}

function logError(message) {
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
  const line = `[conductor-daemon ${ts}] ${message}\n`;
  process.stderr.write(line);
  appendDaemonLog(line);
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  try {
    Atomics.wait(BLOCKING_SLEEP_BUFFER, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // best-effort fallback for runtimes that disallow Atomics.wait
    }
  }
}

function getUserConfig(configFilePath) {
  try {
    const home = os.homedir();
    const configPath = configFilePath || path.join(home, ".conductor", "config.yaml");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8");
      const parsed = yaml.load(content);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  } catch (error) {
    // ignore error
  }
  return {};
}

function normalizePlanLimitType(limitType) {
  if (typeof limitType !== "string") {
    return null;
  }
  const normalized = limitType.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "free_daemon_connection" || normalized === "free-daemon-limit") {
    return "daemon_active_connection";
  }
  return normalized;
}

function inferPlanLimitMessage(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  const lower = text.trim().toLowerCase();
  if (lower.includes("one active manual fire task")) {
    return PLAN_LIMIT_MESSAGES.manual_fire_active_task;
  }
  if (lower.includes("one active app task")) {
    return PLAN_LIMIT_MESSAGES.app_active_task;
  }
  if (lower.includes("one active daemon connection")) {
    return PLAN_LIMIT_MESSAGES.daemon_active_connection;
  }
  if (lower.includes("free plan task limit reached")) {
    return "Free plan task limit reached: only 1 active fire task and 1 active app task are allowed.";
  }
  return null;
}

function getPlanLimitMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const normalizedType = normalizePlanLimitType(payload.limit_type);
  if (normalizedType && PLAN_LIMIT_MESSAGES[normalizedType]) {
    return PLAN_LIMIT_MESSAGES[normalizedType];
  }
  return inferPlanLimitMessage(payload.message) || inferPlanLimitMessage(payload.error);
}

// Default CLI commands for supported backends
const DEFAULT_CLI_LIST = {
  codex: "codex --dangerously-bypass-approvals-and-sandbox",
  claude: "claude --dangerously-skip-permissions",
  opencode: "opencode",
  copilot: "copilot",
};

const LEGACY_RUNTIME_BACKEND_ALIASES = new Set(["code", "claude-code", "open-code", "open_code", "kimi-cli", "kimi-code"]);

function filterConfiguredAllowCliList(allowCliList) {
  if (!allowCliList || typeof allowCliList !== "object") {
    return {};
  }
  const filtered = {};
  for (const [backend, command] of Object.entries(allowCliList)) {
    const normalizedBackend = normalizeRuntimeBackendName(backend);
    if (
      !normalizedBackend ||
      LEGACY_RUNTIME_BACKEND_ALIASES.has(normalizedBackend)
    ) {
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

function getAllowCliList(userConfig) {
  // If user has configured allow_cli_list, use it; otherwise use defaults
  if (userConfig.allow_cli_list && typeof userConfig.allow_cli_list === "object") {
    return filterConfiguredAllowCliList(userConfig.allow_cli_list);
  }
  return DEFAULT_CLI_LIST;
}

function getRawAllowCliList(userConfig) {
  if (userConfig.allow_cli_list && typeof userConfig.allow_cli_list === "object") {
    return userConfig.allow_cli_list;
  }
  return DEFAULT_CLI_LIST;
}

function formatBackendLaunchCommand(cliCommand) {
  return typeof cliCommand === "string" && cliCommand.trim() ? cliCommand.trim() : "ai-sdk-managed";
}

function serializeRuntimeBackendMap(runtimeBackendMap) {
  if (!runtimeBackendMap || typeof runtimeBackendMap !== "object") {
    return "";
  }
  return Object.entries(runtimeBackendMap)
    .filter(([backend, runtimeBackend]) => backend && runtimeBackend)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([backend, runtimeBackend]) => `${backend}=${runtimeBackend}`)
    .join(",");
}

async function defaultCreatePty(command, args, options) {
  if (!nodePtySpawnPromise) {
    const spawnHelperInfo = ensureNodePtySpawnHelperExecutable();
    if (spawnHelperInfo?.updated) {
      log(`Enabled execute permission on node-pty spawn-helper: ${spawnHelperInfo.helperPath}`);
    }
    nodePtySpawnPromise = Promise.resolve(resolveNodePtySpawnExport(moduleRequire("node-pty")));
  }
  const spawnPty = await nodePtySpawnPromise;
  return spawnPty(command, args, options);
}

export function resolveDefaultPtyShell({
  explicitShell,
  envShell = process.env.SHELL,
  comspec = process.env.COMSPEC,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const normalizedExplicitShell = normalizeOptionalString(explicitShell);
  if (normalizedExplicitShell) {
    return normalizedExplicitShell;
  }

  const normalizedEnvShell = normalizeOptionalString(envShell);
  if (normalizedEnvShell) {
    return normalizedEnvShell;
  }

  if (platform === "win32") {
    return normalizeOptionalString(comspec) || "cmd.exe";
  }

  if (platform === "darwin") {
    return "/bin/zsh";
  }

  if (existsSync("/bin/bash")) {
    return "/bin/bash";
  }

  if (existsSync("/bin/sh")) {
    return "/bin/sh";
  }

  return "/bin/bash";
}

export function ensureNodePtySpawnHelperExecutable(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === "win32") {
    return null;
  }

  const arch = deps.arch || process.arch;
  const existsSyncFn = deps.existsSync || fs.existsSync;
  const statSyncFn = deps.statSync || fs.statSync;
  const chmodSyncFn = deps.chmodSync || fs.chmodSync;
  let packageJsonPath = deps.packageJsonPath || null;

  if (!packageJsonPath) {
    try {
      packageJsonPath = moduleRequire.resolve("node-pty/package.json");
    } catch {
      return null;
    }
  }

  const packageDir = path.dirname(packageJsonPath);
  const helperCandidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
  ];
  const helperPath = helperCandidates.find((candidate) => existsSyncFn(candidate));
  if (!helperPath) {
    return null;
  }

  const currentMode = statSyncFn(helperPath).mode & 0o777;
  if ((currentMode & 0o111) !== 0) {
    return { helperPath, updated: false };
  }

  const nextMode = currentMode | 0o111;
  chmodSyncFn(helperPath, nextMode);
  return { helperPath, updated: true };
}

export function isSafeTaskWorktreeRoot(projectWorkspacePath, worktreeRoot) {
  const normalizedWorkspacePath =
    typeof projectWorkspacePath === "string" ? projectWorkspacePath.trim() : "";
  const normalizedWorktreeRoot =
    typeof worktreeRoot === "string" ? worktreeRoot.trim() : "";
  if (!normalizedWorkspacePath || !normalizedWorktreeRoot) {
    return false;
  }

  const resolvedWorkspacePath = path.resolve(normalizedWorkspacePath);
  const resolvedWorktreeRoot = path.resolve(normalizedWorktreeRoot);
  if (resolvedWorkspacePath === resolvedWorktreeRoot) {
    return false;
  }

  const expectedParent = path.resolve(resolvedWorkspacePath, ".conductor", "worktrees");
  const relativeToExpectedParent = path.relative(expectedParent, resolvedWorktreeRoot);
  if (
    !relativeToExpectedParent ||
    relativeToExpectedParent === "." ||
    relativeToExpectedParent.startsWith("..") ||
    path.isAbsolute(relativeToExpectedParent)
  ) {
    return false;
  }

  return true;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function resolveImportTarget(specifierOrPath) {
  const normalized = normalizeOptionalString(specifierOrPath);
  if (!normalized) {
    return null;
  }
  if (
    normalized.startsWith("file:") ||
    normalized.startsWith("node:") ||
    normalized.startsWith("data:")
  ) {
    return normalized;
  }
  if (path.isAbsolute(normalized) || normalized.startsWith("./") || normalized.startsWith("../")) {
    return pathToFileURL(path.resolve(normalized)).href;
  }
  return normalized;
}

function normalizeTerminalResumeStrategy(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase() === "snapshot" ? "snapshot" : null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function normalizeNonNegativeInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return fallback;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
}

function normalizeLaunchConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseTaskWorktreeLaunchConfig(launchConfig) {
  const normalizedLaunchConfig = normalizeLaunchConfig(launchConfig);
  const worktreeEnabled = normalizeBooleanFlag(
    normalizedLaunchConfig.worktree ??
      normalizedLaunchConfig.createWorktree ??
      normalizedLaunchConfig.create_worktree,
  );
  if (!worktreeEnabled) {
    return null;
  }

  const worktreeId =
    normalizeOptionalString(normalizedLaunchConfig.worktreeId) ||
    normalizeOptionalString(normalizedLaunchConfig.worktree_id);
  const worktreeBranch =
    normalizeOptionalString(normalizedLaunchConfig.worktreeBranch) ||
    normalizeOptionalString(normalizedLaunchConfig.worktree_branch);
  const projectRepoRoot =
    normalizeOptionalString(normalizedLaunchConfig.projectRepoRoot) ||
    normalizeOptionalString(normalizedLaunchConfig.project_repo_root);
  const projectWorkspacePath =
    normalizeOptionalString(normalizedLaunchConfig.projectWorkspacePath) ||
    normalizeOptionalString(normalizedLaunchConfig.project_workspace_path);
  const projectRelativePath =
    normalizeOptionalString(normalizedLaunchConfig.projectRelativePath) ||
    normalizeOptionalString(normalizedLaunchConfig.project_relative_path) ||
    ".";
  if (!worktreeId || !worktreeBranch || !projectRepoRoot || !projectWorkspacePath) {
    return null;
  }

  return {
    worktreeId,
    worktreeBranch,
    worktreeBaseRef:
      normalizeOptionalString(normalizedLaunchConfig.worktreeBaseRef) ||
      normalizeOptionalString(normalizedLaunchConfig.worktree_base_ref) ||
      "HEAD",
    projectRepoRoot,
    projectWorkspacePath,
    projectRelativePath,
  };
}

function normalizeTerminalEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      env[key] = raw;
      continue;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
      env[key] = String(raw);
    }
  }
  return env;
}

const PTY_TASK_SCOPED_ENV_KEYS = [
  "CONDUCTOR_PROJECT_ID",
  "CONDUCTOR_TASK_ID",
  "CONDUCTOR_PTY_SESSION_ID",
  "CONDUCTOR_LAUNCHED_BY_DAEMON",
  "CONDUCTOR_RESUME_CWD",
];

function stripPtyTaskScopedEnv(source) {
  const env = {
    ...(source && typeof source === "object" ? source : {}),
  };
  for (const key of PTY_TASK_SCOPED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function buildPtyTaskEnv(baseEnv = process.env, launchEnv = {}) {
  const parentEnv = stripPtyTaskScopedEnv(baseEnv);
  const taskLaunchEnv = stripPtyTaskScopedEnv(launchEnv);
  const env = {
    ...parentEnv,
  };
  return {
    ...env,
    ...taskLaunchEnv,
  };
}

export function startDaemon(config = {}, deps = {}) {
  const exitFn = deps.exit || process.exit;
  const killFn = deps.kill || process.kill;
  let requestShutdown = async () => {};
  let shutdownSignalHandled = false;
  let forcedSignalExitHandled = false;
  let processHandlersAttached = false;

  const removeProcessListener = (eventName, handler) => {
    if (typeof process.off === "function") {
      process.off(eventName, handler);
      return;
    }
    process.removeListener(eventName, handler);
  };

  const exitAndReturn = (code) => {
    exitFn(code);
    return { close: () => {} };
  };

  const isProcessAlive = (pid) => {
    try {
      killFn(pid, 0);
      return true;
    } catch (err) {
      if (err && err.code === "ESRCH") {
        return false;
      }
      throw err;
    }
  };

  let fileConfig;
  try {
    fileConfig = loadConfig(config.CONFIG_FILE);
    log(`Loaded config from ${config.CONFIG_FILE || "~/.conductor/config.yaml"}`);
  } catch (err) {
    if (!(err instanceof ConfigFileNotFound)) {
      log(`Failed to load config: ${err.message}`);
    }
  }

  const userConfig = getUserConfig(config.CONFIG_FILE);
  const explicitWsUrl =
    config.BACKEND_URL ||
    process.env.CONDUCTOR_BACKEND_WS_URL ||
    process.env.CONDUCTOR_WS_URL ||
    null;
  const derivedHttpFromWs = explicitWsUrl ? deriveBackendHttpFromWebsocket(explicitWsUrl) : null;
  const BACKEND_HTTP =
    config.BACKEND_HTTP ||
    process.env.CONDUCTOR_BACKEND_URL ||
    derivedHttpFromWs ||
    fileConfig?.backendUrl ||
    "http://localhost:6152";
  const BACKEND_URL =
    explicitWsUrl ||
    deriveWebsocketUrlFromHttp(BACKEND_HTTP);
  const AGENT_TOKEN =
    config.AGENT_TOKEN || process.env.CONDUCTOR_AGENT_TOKEN || fileConfig?.agentToken || "default-agent-token";
  const configuredDaemonName =
    (typeof userConfig.daemon_name === "string" && userConfig.daemon_name.trim()) ||
    (typeof fileConfig?.daemonName === "string" && fileConfig.daemonName.trim()) ||
    "";
  const AGENT_NAME = (
    config.DAEMON_NAME ||
    configuredDaemonName ||
    process.env.CONDUCTOR_DAEMON_NAME ||
    os.hostname()
  ).trim();
  if (!AGENT_NAME) {
    logError("Daemon name is required. Set daemon_name in ~/.conductor/config.yaml or CONDUCTOR_DAEMON_NAME.");
    return exitAndReturn(1);
  }
  const homeDir = process.env.HOME || os.homedir() || "/tmp";
  const workspaceRootValue =
    config.WORKSPACE_ROOT ||
    process.env.CONDUCTOR_WS ||
    userConfig.workspace ||
    path.join(homeDir, "ws");
  const WORKSPACE_ROOT = expandHomePath(workspaceRootValue, homeDir);
  const CLI_PATH_VAL = config.CLI_PATH || CLI_PATH;

  // Get allow_cli_list from config
  const RAW_ALLOW_CLI_LIST = getRawAllowCliList(userConfig);
  let ALLOW_CLI_LIST = {};
  let SUPPORTED_BACKENDS = [];
  let SUPPORTED_BACKEND_RUNTIME_MAP = {};
  const fetchLatestVersionFn = deps.fetchLatestVersion || fetchLatestVersion;
  const isNewerVersionFn = deps.isNewerVersion || isNewerVersion;
  const detectPackageManagerFn = deps.detectPackageManager || detectPackageManager;
  const parseUpdateWindowFn = deps.parseUpdateWindow || parseUpdateWindow;
  const isInUpdateWindowFn = deps.isInUpdateWindow || isInUpdateWindow;
  const isManagedInstallPathFn = deps.isManagedInstallPath || isManagedInstallPath;
  const resolveInstallMethodFn = deps.resolveInstallMethod || resolveInstallMethod;
  const installedPackageRoot = deps.packageRoot || PACKAGE_ROOT;
  const cliVersion = deps.cliVersion || CLI_VERSION;
  const isBackgroundProcess = deps.isBackgroundProcess ?? !process.stdout.isTTY;
  const autoUpdateForceLocal = parseBooleanEnv(process.env.CONDUCTOR_AUTO_UPDATE_FORCE_LOCAL);
  const installMethod = resolveInstallMethodFn({
    env: process.env,
    packageRoot: installedPackageRoot,
    readFileSync: deps.readFileSync || fs.readFileSync,
  });
  const autoUpdateSupportedInstall =
    (installMethod !== "homebrew") &&
    (autoUpdateForceLocal || isManagedInstallPathFn(installedPackageRoot, {
      env: process.env,
      readFileSync: deps.readFileSync || fs.readFileSync,
    }));
  const skipPidLockCheck = parseBooleanEnv(process.env.CONDUCTOR_TUI_DEBUG);
  const lockHandoffToken =
    normalizeOptionalString(config.LOCK_HANDOFF_TOKEN) ||
    normalizeOptionalString(process.env.CONDUCTOR_LOCK_HANDOFF_TOKEN);
  const lockHandoffFromPid = normalizePositiveInt(
    config.LOCK_HANDOFF_FROM_PID || process.env.CONDUCTOR_LOCK_HANDOFF_FROM_PID,
    null,
  );
  const restartLauncherScript = normalizeOptionalString(config.RESTART_LAUNCHER_SCRIPT);
  const restartLauncherArgs = normalizeStringArray(config.RESTART_LAUNCHER_ARGS);
  const normalizedVersionCheckArgs = normalizeStringArray(config.VERSION_CHECK_ARGS);
  const versionCheckScript =
    normalizeOptionalString(config.VERSION_CHECK_SCRIPT) || restartLauncherScript;
  const versionCheckArgs =
    normalizedVersionCheckArgs.length > 0
      ? normalizedVersionCheckArgs
      : ["--version"];

  // Auto-update configuration
  const AUTO_UPDATE_ENABLED =
    autoUpdateSupportedInstall &&
    (process.env.CONDUCTOR_AUTO_UPDATE !== "false") &&
    (userConfig.auto_update !== false);
  // Auto-update respawn was historically broken in prod (camelCase/UPPER_SNAKE
  // config-key mismatch between conductor-daemon.js and daemon.js), so no fleet
  // has actually restarted itself via this path. The key mismatch is now fixed,
  // which means auto-update would start respawning daemons globally. To avoid a
  // silent activation, keep respawn gated behind an explicit opt-in until it
  // has been validated on a canary.
  const AUTO_UPDATE_RESPAWN_ENABLED =
    config.AUTO_UPDATE_RESPAWN === true ||
    config.AUTO_UPDATE_RESPAWN === "true" ||
    process.env.CONDUCTOR_AUTO_UPDATE_RESPAWN === "true" ||
    userConfig.auto_update_respawn === true;
  const UPDATE_WINDOW = parseUpdateWindowFn(
    process.env.CONDUCTOR_UPDATE_WINDOW || userConfig.update_window || "02:00-04:00"
  );

  const spawnFn = deps.spawn || spawn;
  const mkdirSyncFn = deps.mkdirSync || fs.mkdirSync;
  const writeFileSyncFn = deps.writeFileSync || fs.writeFileSync;
  const existsSyncFn = deps.existsSync || fs.existsSync;
  const statSyncFn = deps.statSync || fs.statSync;
  const lstatSyncFn = deps.lstatSync || fs.lstatSync;
  const readFileSyncFn = deps.readFileSync || fs.readFileSync;
  const readlinkSyncFn = deps.readlinkSync || fs.readlinkSync;
  const symlinkSyncFn = deps.symlinkSync || fs.symlinkSync;
  const unlinkSyncFn = deps.unlinkSync || fs.unlinkSync;
  const renameSyncFn = deps.renameSync || fs.renameSync;
  const createWriteStreamFn = deps.createWriteStream || fs.createWriteStream;
  const fetchFn = deps.fetch || fetch;
  const createRtcPeerConnection = deps.createRtcPeerConnection || null;
  const importOptionalModule = deps.importOptionalModule || ((moduleName) => import(moduleName));
  const createWebSocketClient =
    deps.createWebSocketClient ||
    ((clientConfig, options) => new ConductorWebSocketClient(clientConfig, options));
  const createLogCollector = deps.createLogCollector || ((backendUrl) => new DaemonLogCollector(backendUrl));
  const resolveProjectSnapshotFn =
    deps.resolveProjectSnapshot || ((projectPath) => new ProjectContext(projectPath).snapshot());

  function buildTaskWorktreeRoot(projectWorkspacePath, worktreeId) {
    const sanitized = String(worktreeId).replace(/[/\\]/g, "_").replace(/\.\./g, "_");
    return path.join(projectWorkspacePath, ".conductor", "worktrees", sanitized);
  }

  function resolveTaskWorktreeCwd(worktreeRoot, projectRelativePath) {
    return projectRelativePath && projectRelativePath !== "."
      ? path.join(worktreeRoot, projectRelativePath)
      : worktreeRoot;
  }

  function normalizeConfiguredPathList(value, projectWorkspacePath = "") {
    const rawList = typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : [];
    const deduped = [];
    for (const entry of rawList) {
      const normalizedEntry = normalizeOptionalString(entry);
      if (!normalizedEntry) continue;
      const exactConfiguredPathExists =
        projectWorkspacePath &&
        existsSyncFn(path.resolve(projectWorkspacePath, normalizedEntry));
      const normalizedEntries =
        !exactConfiguredPathExists && /\s/.test(normalizedEntry)
          ? normalizedEntry.split(/\s+/).map((part) => normalizeOptionalString(part)).filter(Boolean)
          : [normalizedEntry];
      for (const candidate of normalizedEntries) {
        if (deduped.includes(candidate)) {
          continue;
        }
        deduped.push(candidate);
      }
    }
    return deduped;
  }

  function resolveProjectScopedPath(basePath, configuredPath, label) {
    const resolvedPath = path.resolve(basePath, configuredPath);
    const relativePath = path.relative(basePath, resolvedPath);
    if (
      relativePath === "" ||
      relativePath === "." ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`${label} must stay within ${basePath}`);
    }
    return resolvedPath;
  }

  const PROJECT_SETTINGS_TEMPLATE = [
    "worktree:",
    "  sync_branch: false",
    "  symlink: []",
    "  # Example: symlink paths from the parent workspace into each worktree",
    "  # symlink:",
    "  #   - node_modules",
    "  #   - .env",
    "",
  ].join("\n");

  function ensureProjectSettingsTemplate(projectWorkspacePath) {
    const settingsPath = path.join(projectWorkspacePath, ".conductor", "settings.yaml");
    if (existsSyncFn(settingsPath)) {
      return;
    }
    try {
      mkdirSyncFn(path.join(projectWorkspacePath, ".conductor"), { recursive: true });
      writeFileSyncFn(settingsPath, PROJECT_SETTINGS_TEMPLATE, "utf8");
    } catch (_error) {
      // best-effort; do not block project validation if template creation fails
    }
  }

  function readProjectWorktreeSettings(projectWorkspacePath) {
    const settingsCandidates = [
      path.join(projectWorkspacePath, ".conductor", "settings.yaml"),
      path.join(projectWorkspacePath, ".conductor", "settings.yml"),
      path.join(projectWorkspacePath, ".conductor", "setttings.yaml"),
      path.join(projectWorkspacePath, ".conductor", "setttings.yml"),
    ];

    for (const settingsPath of settingsCandidates) {
      if (!existsSyncFn(settingsPath)) {
        continue;
      }
      try {
        const parsed = yaml.load(readFileSyncFn(settingsPath, "utf8"));
        const worktreeSettings =
          parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          parsed.worktree && typeof parsed.worktree === "object" && !Array.isArray(parsed.worktree)
            ? parsed.worktree
            : {};
        return {
          symlinkPaths: normalizeConfiguredPathList(worktreeSettings.symlink, projectWorkspacePath),
          syncBranch: worktreeSettings.sync_branch === true || worktreeSettings.syncBranch === true,
          settingsPath,
        };
      } catch (error) {
        throw new Error(`Failed to read ${settingsPath}: ${error?.message || error}`);
      }
    }

    return {
      symlinkPaths: [],
      syncBranch: false,
      settingsPath: null,
    };
  }

  function ensureTaskWorktreeSymlinks({ projectWorkspacePath, finalCwd }) {
    const { symlinkPaths } = readProjectWorktreeSettings(projectWorkspacePath);
    for (const configuredPath of symlinkPaths) {
      const sourcePath = resolveProjectScopedPath(
        projectWorkspacePath,
        configuredPath,
        `worktree.symlink entry ${configuredPath}`,
      );
      const linkPath = resolveProjectScopedPath(
        finalCwd,
        configuredPath,
        `worktree.symlink destination ${configuredPath}`,
      );
      mkdirSyncFn(path.dirname(linkPath), { recursive: true });

      if (existsSyncFn(linkPath)) {
        try {
          const stat = lstatSyncFn(linkPath);
          if (!stat.isSymbolicLink()) {
            throw new Error(`worktree symlink destination already exists: ${linkPath}`);
          }
          const currentTarget = readlinkSyncFn(linkPath);
          const currentResolvedTarget = path.resolve(path.dirname(linkPath), currentTarget);
          if (currentResolvedTarget === sourcePath) {
            continue;
          }
          throw new Error(`worktree symlink destination already points elsewhere: ${linkPath}`);
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }

      const relativeTarget = path.relative(path.dirname(linkPath), sourcePath) || ".";
      symlinkSyncFn(relativeTarget, linkPath);
    }
  }

  async function runSpawnProcess(command, args, options = {}) {
    let child;
    const { timeoutMs, ...spawnOptions } = options || {};
    try {
      child = spawnFn(command, args, {
        ...spawnOptions,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutHandle = null;

      const finishResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        resolve({ stdout, stderr });
      };

      const finishReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          try {
            if (child && typeof child.kill === "function") {
              child.kill("SIGTERM");
            }
          } catch {
            // ignore process kill failures; the timeout error is the useful signal
          }
          finishReject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      if (child.stdout && typeof child.stdout.on === "function") {
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk ?? "");
        });
      }
      if (child.stderr && typeof child.stderr.on === "function") {
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk ?? "");
        });
      }
      if (typeof child.on === "function") {
        child.on("error", (error) => {
          finishReject(error);
        });
        child.on("close", (code, signal) => {
          if (code === 0) {
            finishResolve();
            return;
          }
          const detail = (stderr || stdout).trim();
          finishReject(
            new Error(
              `${command} ${args.join(" ")} failed` +
                (signal ? ` (signal ${signal})` : ` (exit ${code ?? "unknown"})`) +
                (detail ? `: ${detail}` : ""),
            ),
          );
        });
        return;
      }
      finishResolve();
    });
  }

  async function ensureTaskWorktree({ taskId, projectId, launchConfig }) {
    const worktreeConfig = parseTaskWorktreeLaunchConfig(launchConfig);
    if (!worktreeConfig) {
      return null;
    }

    const worktreeRoot = buildTaskWorktreeRoot(
      worktreeConfig.projectWorkspacePath,
      worktreeConfig.worktreeId,
    );
    const finalCwd = resolveTaskWorktreeCwd(worktreeRoot, worktreeConfig.projectRelativePath);
    const gitMarkerPath = path.join(worktreeRoot, ".git");
    if (!existsSyncFn(gitMarkerPath)) {
      const { syncBranch } = readProjectWorktreeSettings(worktreeConfig.projectWorkspacePath);
      if (syncBranch) {
        try {
          const { stdout: remoteStdout } = await runSpawnProcess(
            "git",
            ["-C", worktreeConfig.projectRepoRoot, "remote"],
            { cwd: worktreeConfig.projectRepoRoot, timeoutMs: WORKTREE_SYNC_TIMEOUT_MS },
          );
          const hasRemote = remoteStdout.trim().length > 0;
          if (hasRemote) {
            await runSpawnProcess(
              "git",
              ["-C", worktreeConfig.projectRepoRoot, "fetch"],
              { cwd: worktreeConfig.projectRepoRoot, timeoutMs: WORKTREE_SYNC_TIMEOUT_MS },
            );
            const { stdout: branchStdout } = await runSpawnProcess(
              "git",
              ["-C", worktreeConfig.projectRepoRoot, "rev-parse", "--abbrev-ref", "HEAD"],
              { cwd: worktreeConfig.projectRepoRoot, timeoutMs: WORKTREE_SYNC_TIMEOUT_MS },
            );
            const currentBranch = branchStdout.trim();
            if (currentBranch && currentBranch !== "HEAD") {
              const { stdout: trackingStdout } = await runSpawnProcess(
                "git",
                ["-C", worktreeConfig.projectRepoRoot, "rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`],
                { cwd: worktreeConfig.projectRepoRoot, timeoutMs: WORKTREE_SYNC_TIMEOUT_MS },
              ).catch(() => ({ stdout: "" }));
              const upstream = trackingStdout.trim();
              if (upstream) {
                await runSpawnProcess(
                  "git",
                  ["-C", worktreeConfig.projectRepoRoot, "merge", "--ff-only", upstream],
                  { cwd: worktreeConfig.projectRepoRoot, timeoutMs: WORKTREE_SYNC_TIMEOUT_MS },
                ).catch(() => {});
              }
            }
          }
        } catch (_syncError) {
          // sync_branch is best-effort; proceed with worktree creation even if sync fails
        }
      }

      mkdirSyncFn(path.dirname(worktreeRoot), { recursive: true });
      try {
        await runSpawnProcess(
          "git",
          [
            "-C",
            worktreeConfig.projectRepoRoot,
            "worktree",
            "add",
            "-b",
            worktreeConfig.worktreeBranch,
            worktreeRoot,
            worktreeConfig.worktreeBaseRef,
          ],
          {
            cwd: worktreeConfig.projectRepoRoot,
          },
        );
      } catch (primaryError) {
        if (!existsSyncFn(gitMarkerPath)) {
          try {
            await runSpawnProcess(
              "git",
              [
                "-C",
                worktreeConfig.projectRepoRoot,
                "worktree",
                "add",
                worktreeRoot,
                worktreeConfig.worktreeBranch,
              ],
              {
                cwd: worktreeConfig.projectRepoRoot,
              },
            );
          } catch (reuseError) {
            throw new Error(
              `Failed to prepare git worktree for ${taskId}: ${reuseError?.message || primaryError?.message || primaryError}`,
            );
          }
        }
      }
    }

    mkdirSyncFn(finalCwd, { recursive: true });
    ensureTaskWorktreeSymlinks({
      projectWorkspacePath: worktreeConfig.projectWorkspacePath,
      finalCwd,
    });
    return finalCwd;
  }

  const RTC_MODULE_CANDIDATES = resolveRtcModuleCandidates(process.env.CONDUCTOR_PTY_RTC_MODULES);
  const RTC_DIRECT_DISABLED = parseBooleanEnv(process.env.CONDUCTOR_DISABLE_PTY_DIRECT_RTC);
  const PROJECT_PATH_LOOKUP_TIMEOUT_MS = parsePositiveInt(
    process.env.CONDUCTOR_PROJECT_PATH_LOOKUP_TIMEOUT_MS,
    1500,
  );
  const STOP_FORCE_KILL_TIMEOUT_MS = parsePositiveInt(
    process.env.CONDUCTOR_STOP_FORCE_KILL_TIMEOUT_MS,
    5000,
  );
  const DAEMON_FORCE_STOP_GRACE_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_FORCE_STOP_GRACE_MS,
    15_000,
  );
  const DAEMON_FORCE_STOP_POLL_INTERVAL_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_FORCE_STOP_POLL_INTERVAL_MS,
    100,
  );
  const DAEMON_FORCE_KILL_WAIT_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_FORCE_KILL_WAIT_MS,
    2_000,
  );
  const WORKTREE_SYNC_TIMEOUT_MS = parsePositiveInt(
    process.env.CONDUCTOR_WORKTREE_SYNC_TIMEOUT_MS,
    5_000,
  );
  const SHUTDOWN_STATUS_REPORT_TIMEOUT_MS = parsePositiveInt(
    process.env.CONDUCTOR_SHUTDOWN_STATUS_REPORT_TIMEOUT_MS,
    1000,
  );
  const SHUTDOWN_DISCONNECT_TIMEOUT_MS = parsePositiveInt(
    process.env.CONDUCTOR_SHUTDOWN_DISCONNECT_TIMEOUT_MS,
    1000,
  );
  const DAEMON_WATCHDOG_INTERVAL_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_WATCHDOG_INTERVAL_MS,
    30_000,
  );
  const DAEMON_WATCHDOG_STALE_WS_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_WATCHDOG_STALE_WS_MS,
    75_000,
  );
  const DAEMON_WATCHDOG_CONNECT_GRACE_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_WATCHDOG_CONNECT_GRACE_MS,
    35_000,
  );
  const DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS,
    45_000,
  );
  const DAEMON_WATCHDOG_HTTP_TIMEOUT_MS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_WATCHDOG_HTTP_TIMEOUT_MS,
    5_000,
  );
  const DAEMON_WATCHDOG_MAX_SELF_HEALS = parsePositiveInt(
    process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS,
    3,
  );
  const TERMINAL_RING_BUFFER_MAX_BYTES = parsePositiveInt(
    config.TERMINAL_RING_BUFFER_MAX_BYTES || process.env.CONDUCTOR_TERMINAL_RING_BUFFER_MAX_BYTES,
    DEFAULT_TERMINAL_RING_BUFFER_MAX_BYTES,
  );
  const TERMINAL_RESUME_SNAPSHOT_MAX_BYTES = parsePositiveInt(
    config.TERMINAL_RESUME_SNAPSHOT_MAX_BYTES || process.env.CONDUCTOR_TERMINAL_RESUME_SNAPSHOT_MAX_BYTES,
    DEFAULT_TERMINAL_RESUME_SNAPSHOT_MAX_BYTES,
  );

  const readLockState = () => {
    const raw = String(readFileSyncFn(LOCK_FILE, "utf-8") || "").trim();
    if (!raw) {
      return null;
    }

    const pid = Number.parseInt(raw, 10);
    if (!Number.isNaN(pid) && pid > 0) {
      return {
        pid,
        handoffFromPid: null,
        handoffToken: null,
        handoffExpiresAt: null,
      };
    }

    try {
      const parsed = JSON.parse(raw);
      const parsedPid = normalizePositiveInt(parsed?.pid, null);
      const parsedHandoffFromPid = normalizePositiveInt(parsed?.handoff_from_pid, null);
      return {
        pid: parsedPid ?? parsedHandoffFromPid,
        handoffFromPid: parsedHandoffFromPid,
        handoffToken: normalizeOptionalString(parsed?.handoff_token),
        handoffExpiresAt: normalizePositiveInt(parsed?.handoff_expires_at, null),
      };
    } catch {
      return null;
    }
  };

  const hasMatchingLockHandoff = (lockState) => {
    if (!lockState || !lockHandoffToken || !lockHandoffFromPid) {
      return false;
    }
    if (lockState.handoffToken !== lockHandoffToken) {
      return false;
    }
    if (lockState.handoffFromPid !== lockHandoffFromPid) {
      return false;
    }
    if (lockState.handoffExpiresAt && lockState.handoffExpiresAt < Date.now()) {
      return false;
    }
    return true;
  };

  const waitForProcessExitSync = (pid, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (!isProcessAlive(pid)) {
        return true;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      sleepSync(Math.min(DAEMON_FORCE_STOP_POLL_INTERVAL_MS, remainingMs));
    }
  };

  try {
    mkdirSyncFn(WORKSPACE_ROOT, { recursive: true });
  } catch (err) {
    logError(`Failed to create workspace root: ${err}`);
    return exitAndReturn(1);
  }

  const LOCK_FILE = path.join(WORKSPACE_ROOT, "daemon.pid");
  try {
    if (skipPidLockCheck) {
      log("CONDUCTOR_TUI_DEBUG enabled; skipping daemon PID lock enforcement");
    } else {
      if (existsSyncFn(LOCK_FILE)) {
        const lockState = readLockState();
        const pid = lockState?.pid;
        if (pid) {
          const handoffMatched = hasMatchingLockHandoff(lockState);
          try {
            if (handoffMatched) {
              log(`Taking over daemon lock from PID ${pid} via handoff`);
            } else {
              const alive = isProcessAlive(pid);
              if (alive) {
                if (config.FORCE) {
                  log(`Force enabled: stopping existing daemon PID ${pid}`);
                  let alreadyExited = false;
                  try {
                    killFn(pid, "SIGTERM");
                  } catch (killErr) {
                    if (killErr?.code === "ESRCH") {
                      alreadyExited = true;
                    } else {
                      logError(`Failed to stop existing daemon PID ${pid}: ${killErr.message}`);
                      return exitAndReturn(1);
                    }
                  }
                  try {
                    let exited = alreadyExited || waitForProcessExitSync(pid, DAEMON_FORCE_STOP_GRACE_MS);
                    if (!exited) {
                      log(
                        `Existing daemon PID ${pid} did not exit within ${DAEMON_FORCE_STOP_GRACE_MS}ms; sending SIGKILL`,
                      );
                      try {
                        killFn(pid, "SIGKILL");
                      } catch (killErr) {
                        if (killErr?.code !== "ESRCH") {
                          logError(`Failed to force kill existing daemon PID ${pid}: ${killErr.message}`);
                          return exitAndReturn(1);
                        }
                      }
                      exited = waitForProcessExitSync(pid, DAEMON_FORCE_KILL_WAIT_MS);
                    }
                    if (!exited) {
                      logError(`Existing daemon PID ${pid} is still running after force restart; please stop it manually.`);
                      return exitAndReturn(1);
                    }
                  } catch (checkErr) {
                    logError(`Failed to verify daemon PID ${pid}: ${checkErr.message}`);
                    return exitAndReturn(1);
                  }
                  log("Removing lock file after force stop");
                  if (existsSyncFn(LOCK_FILE)) {
                    unlinkSyncFn(LOCK_FILE);
                  }
                } else {
                  logError(`Daemon already running with PID ${pid}`);
                  return exitAndReturn(1);
                }
              } else {
                log("Removing stale lock file");
                unlinkSyncFn(LOCK_FILE);
              }
            }
          } catch (e) {
            if (handoffMatched) {
              log(`Taking over daemon lock from PID ${pid} via handoff`);
            } else {
              logError(`Daemon already running with PID ${pid} (access denied)`);
              return exitAndReturn(1);
            }
          }
        } else {
          log("Removing malformed lock file");
          unlinkSyncFn(LOCK_FILE);
        }
      }
      writeFileSyncFn(LOCK_FILE, process.pid.toString());
    }
  } catch (err) {
    logError("Failed to acquire lock:", err);
    return exitAndReturn(1);
  }

  const cleanupLock = () => {
    if (skipPidLockCheck) {
      return;
    }
    try {
      if (existsSyncFn(LOCK_FILE)) {
        const lockState = readLockState();
        if (lockState?.pid === process.pid) {
          unlinkSyncFn(LOCK_FILE);
        }
      }
    } catch (e) {
      // ignore
    }
  };

  const writeLockHandoff = ({ handoffToken, handoffFromPid, handoffExpiresAt }) => {
    if (skipPidLockCheck) {
      return;
    }
    writeFileSyncFn(
      LOCK_FILE,
      JSON.stringify({
        pid: handoffFromPid,
        handoff_from_pid: handoffFromPid,
        handoff_token: handoffToken,
        handoff_expires_at: handoffExpiresAt,
      }),
    );
  };

  const signalExitCode = (signal) => (signal === "SIGINT" ? 130 : 143);
  const handleSignal = (signal) => {
    if (shutdownSignalHandled) {
      if (forcedSignalExitHandled) return;
      forcedSignalExitHandled = true;
      log(`Received ${signal} again, forcing exit now`);
      cleanupLock();
      exitFn(signalExitCode(signal));
      return;
    }
    shutdownSignalHandled = true;
    void (async () => {
      try {
        log(`Received ${signal}, shutting down...`);
        await requestShutdown(`signal ${signal}`);
      } catch (err) {
        logError(`Graceful shutdown failed on ${signal}: ${err?.message || err}`);
      } finally {
        cleanupLock();
        exitFn(signalExitCode(signal));
      }
    })();
  };
  const onSigInt = () => {
    handleSignal("SIGINT");
  };
  const onSigTerm = () => {
    handleSignal("SIGTERM");
  };
  const onUncaughtException = (err) => {
    logError(`Uncaught exception: ${err}`);
    cleanupLock();
    exitFn(1);
  };
  const detachProcessHandlers = () => {
    if (!processHandlersAttached) {
      return;
    }
    processHandlersAttached = false;
    removeProcessListener("exit", cleanupLock);
    removeProcessListener("SIGINT", onSigInt);
    removeProcessListener("SIGTERM", onSigTerm);
    removeProcessListener("uncaughtException", onUncaughtException);
  };

  process.on("exit", cleanupLock);
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("uncaughtException", onUncaughtException);
  processHandlersAttached = true;

  if (config.CLEAN_ALL) {
    cleanAllAgents(BACKEND_HTTP, AGENT_TOKEN, fetchFn)
      .then((result) => {
        log(`Cleaned stale daemons: removed=${result.removed} remaining=${result.remaining}`);
      })
      .catch((err) => {
        log(`Failed to clean daemons: ${err.message}`);
      })
      .finally(() => {
        detachProcessHandlers();
        exitFn(0);
      });
    return { close: detachProcessHandlers };
  }

  const sdkConfig = new ConductorConfig({
    agentToken: AGENT_TOKEN,
    backendUrl: BACKEND_HTTP,
    websocketUrl: BACKEND_URL,
  });

  let disconnectedSinceLastConnectedLog = false;
  let didRecoverStaleTasks = false;
  let daemonShuttingDown = false;
  const activeTaskProcesses = new Map();
  const pendingTaskStarts = new Set();
  const activePtySessions = new Map();
  const activePtyRtcTransports = new Map();
  const suppressedExitStatusReports = new Set();
  const seenCommandRequestIds = new Set();
  const completedCommandRequestAckResults = new Map();
  const refreshSessionRestartTaskIds = new Set();
  let lastConnectedAt = null;
  let lastPongAt = null;
  let lastInboundAt = null;
  let lastSuccessfulHttpAt = null;
  let lastPresenceCheckAt = null;
  let lastPresenceConfirmedAt = null;
  let wsConnected = false;
  let watchdogLastHealAt = 0;
  let watchdogHealAttempts = 0;
  let watchdogProbeInFlight = false;
  let watchdogLastProbeErrorAt = 0;
  let watchdogLastPresenceMismatchAt = 0;
  let watchdogAwaitingHealthySignalAt = null;
  let watchdogTimer = null;

  // --- Auto-update state ---
  const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  let lastVersionCheckAt = 0;
  let latestKnownVersion = null;
  let updateAvailable = false;
  let autoUpdateInProgress = false;

  let rtcImplementationPromise = null;
  let rtcAvailabilityLogKey = null;
  const logCollector = createLogCollector(BACKEND_HTTP);
  const createPtyFn = deps.createPty || defaultCreatePty;
  const resolvePtyTaskCapabilityFn =
    deps.resolvePtyTaskCapability ||
    (deps.createPty
      ? (() => ({ enabled: true, reason: null, spawnHelperInfo: null, spawnPty: null }))
      : probePtyTaskCapability);
  let ptyTaskCapability;
  try {
    ptyTaskCapability = resolvePtyTaskCapabilityFn();
  } catch (error) {
    ptyTaskCapability = {
      enabled: false,
      reason: error instanceof Error ? error.message : String(error),
      spawnHelperInfo: null,
      spawnPty: null,
    };
  }
  const ptyTaskCapabilityEnabled = ptyTaskCapability?.enabled !== false;
  const ptyTaskCapabilityError = normalizeOptionalString(ptyTaskCapability?.reason);
  if (ptyTaskCapability?.spawnHelperInfo?.updated) {
    log(`Enabled execute permission on node-pty spawn-helper: ${ptyTaskCapability.spawnHelperInfo.helperPath}`);
  }
  if (!ptyTaskCapabilityEnabled) {
    logError(`[pty] Disabled PTY capability: ${ptyTaskCapabilityError || "unknown error"}`);
  }
  const extraHeaders = {
    "x-conductor-host": AGENT_NAME,
    "x-conductor-backends": SUPPORTED_BACKENDS.join(","),
    "x-conductor-version": cliVersion,
  };
  const advertisedCapabilities = ["project_path_validation", "restart_daemon", "refresh_session_inplace"];
  if (ptyTaskCapabilityEnabled) {
    advertisedCapabilities.push("pty_task", "terminal_snapshot");
  }
  if (advertisedCapabilities.length > 0) {
    extraHeaders["x-conductor-capabilities"] = advertisedCapabilities.join(",");
  }
  const aiManagerHandlers = createAiManagerHandlers({ configPath: config.CONFIG_FILE });

  const client = createWebSocketClient(sdkConfig, {
    extraHeaders,
    onConnected: ({ isReconnect, connectedAt } = { isReconnect: false, connectedAt: Date.now() }) => {
      wsConnected = true;
      lastConnectedAt = connectedAt || Date.now();
      lastPongAt = lastPongAt && lastPongAt > lastConnectedAt ? lastPongAt : lastConnectedAt;
      if (!isReconnect || disconnectedSinceLastConnectedLog) {
        log("Connected to backend");
      }
      if (watchdogHealAttempts > 0) {
        watchdogAwaitingHealthySignalAt = lastConnectedAt;
      } else {
        watchdogAwaitingHealthySignalAt = null;
      }
      disconnectedSinceLastConnectedLog = false;
      sendAgentResume(isReconnect).catch((error) => {
        logError(`sendAgentResume failed: ${error?.message || error}`);
      });
      if (!didRecoverStaleTasks) {
        didRecoverStaleTasks = true;
        recoverStaleTasks().catch((error) => {
          logError(`recoverStaleTasks failed: ${error?.message || error}`);
        });
      } else if (isReconnect) {
        reconcileAssignedTasks().catch((error) => {
          logError(`reconcileAssignedTasks failed: ${error?.message || error}`);
        });
      }
    },
    onDisconnected: (event = {}) => {
      wsConnected = false;
      disconnectedSinceLastConnectedLog = true;
      if (!daemonShuttingDown) {
        logError(
          `[daemon-ws] Disconnected from backend: ${formatDisconnectDiagnostics(event)} (${formatDaemonHealthState({
            connectedAt: lastConnectedAt,
            lastPongAt,
            lastInboundAt,
            lastSuccessfulHttpAt,
            lastPresenceConfirmedAt,
          })})`,
        );
      }
    },
    onPong: ({ at }) => {
      lastPongAt = at;
      markWatchdogHealthy("pong", at);
    },
  });

  client.registerHandler((payload) => {
    handleEvent(payload);
  });

  void (async () => {
    try {
      ALLOW_CLI_LIST = await filterRuntimeSupportedAllowCliList(RAW_ALLOW_CLI_LIST, {
        configFilePath: config.CONFIG_FILE,
      });
    } catch (error) {
      ALLOW_CLI_LIST = {};
      logError(`Failed to filter configured backends: ${error?.message || error}`);
    }

    try {
      const advertisedBackends = await listAdvertisedBackends(ALLOW_CLI_LIST, {
        configFilePath: config.CONFIG_FILE,
      });
      SUPPORTED_BACKENDS = advertisedBackends.supportedBackends;
      SUPPORTED_BACKEND_RUNTIME_MAP = advertisedBackends.runtimeBackendMap;
      if (advertisedBackends.discoveryError) {
        logError(`Failed to discover external backends: ${advertisedBackends.discoveryError?.message || advertisedBackends.discoveryError}`);
      }
    } catch (error) {
      SUPPORTED_BACKENDS = [];
      SUPPORTED_BACKEND_RUNTIME_MAP = {};
      logError(`Failed to resolve advertised backends: ${error?.message || error}`);
    }

    extraHeaders["x-conductor-backends"] = SUPPORTED_BACKENDS.join(",");
    extraHeaders["x-conductor-backend-runtime-map"] = serializeRuntimeBackendMap(SUPPORTED_BACKEND_RUNTIME_MAP);
    if (typeof client?.setExtraHeaders === "function") {
      client.setExtraHeaders(extraHeaders);
    }
    if (daemonShuttingDown) {
      return;
    }

    log("Daemon starting...");
    log(`Backend: ${BACKEND_URL}`);
    log(`Workspace: ${WORKSPACE_ROOT}`);
    log(`CLI Path: ${CLI_PATH_VAL}`);
    log(`Daemon Name: ${AGENT_NAME}`);
    log(`Supported Backends: ${SUPPORTED_BACKENDS.join(", ")}`);

    client.connect().catch((err) => {
      logError(`Failed to connect: ${err}`);
    });

    if (!AUTO_UPDATE_ENABLED && autoUpdateSupportedInstall === false) {
      if (installMethod === "homebrew") {
        log(`[auto-update] Disabled for Homebrew install; use ${buildUpgradeCommand({ env: process.env })}`);
      } else {
        log("[auto-update] Disabled for local/dev install; set CONDUCTOR_AUTO_UPDATE_FORCE_LOCAL=true to override");
      }
    }

    const runMaintenanceTick = async () => {
      void runDaemonWatchdog();
      try {
        await checkForUpdate();
      } catch {
        // ignore non-critical version check failures
      }
      try {
        await tryAutoUpdate();
      } catch {
        // ignore non-critical auto-update failures
      }
    };

    watchdogTimer = setInterval(() => {
      void runMaintenanceTick();
    }, DAEMON_WATCHDOG_INTERVAL_MS);
    if (typeof watchdogTimer?.unref === "function") {
      watchdogTimer.unref();
    }
    void runMaintenanceTick();
  })();

  function markBackendHttpSuccess(at = Date.now()) {
    lastSuccessfulHttpAt = at;
  }

  async function probeAgentPresence() {
    lastPresenceCheckAt = Date.now();
    try {
      const response = await withTimeout(
        fetchFn(`${BACKEND_HTTP}/api/agents`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${AGENT_TOKEN}`,
            Accept: "application/json",
          },
        }),
        DAEMON_WATCHDOG_HTTP_TIMEOUT_MS,
        "daemon agent presence probe",
      );
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: `HTTP ${response.status}`,
        };
      }
      const at = Date.now();
      markBackendHttpSuccess(at);
      const payload = await response.json();
      const agents = Array.isArray(payload) ? payload : [];
      const selfOnline = agents.some((entry) => String(entry?.host || "").trim() === AGENT_NAME);
      if (selfOnline) {
        lastPresenceConfirmedAt = at;
      }
      return {
        ok: true,
        selfOnline,
        agentCount: agents.length,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error?.message || String(error),
      };
    }
  }

  function requestWatchdogSelfHeal(reason, extra = {}) {
    if (daemonShuttingDown || !wsConnected) {
      return;
    }
    const now = Date.now();
    if (watchdogLastHealAt && now - watchdogLastHealAt < DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS) {
      return;
    }
    watchdogLastHealAt = now;
    watchdogHealAttempts += 1;
    logError(
      `[watchdog] ${reason}; restarting daemon websocket (${watchdogHealAttempts}/${DAEMON_WATCHDOG_MAX_SELF_HEALS}) ${formatWatchdogExtra(extra)} (${formatDaemonHealthState({
        connectedAt: lastConnectedAt,
        lastPongAt,
        lastInboundAt,
        lastSuccessfulHttpAt,
        lastPresenceConfirmedAt,
      })})`,
    );
    if (watchdogHealAttempts > DAEMON_WATCHDOG_MAX_SELF_HEALS) {
      daemonShuttingDown = true;
      logError("[watchdog] Self-heal budget exceeded; exiting daemon for supervisor restart");
      void requestShutdown("watchdog self-heal budget exceeded")
        .catch((error) => {
          logError(`watchdog shutdown failed: ${error?.message || error}`);
        })
        .finally(() => {
          cleanupLock();
          exitFn(1);
        });
      return;
    }
    watchdogAwaitingHealthySignalAt = null;
    wsConnected = false;
    disconnectedSinceLastConnectedLog = true;
    if (typeof client.forceReconnect === "function") {
      Promise.resolve(client.forceReconnect(`watchdog:${reason}`)).catch((error) => {
        logError(`watchdog forceReconnect failed: ${error?.message || error}`);
      });
      return;
    }
    Promise.resolve(client.disconnect())
      .catch((error) => {
        logError(`watchdog disconnect failed: ${error?.message || error}`);
      })
      .finally(() => {
        client.connect().catch((error) => {
          logError(`watchdog reconnect failed: ${error?.message || error}`);
        });
      });
  }

  async function runDaemonWatchdog() {
    if (daemonShuttingDown || !wsConnected || watchdogProbeInFlight) {
      return;
    }
    const startedAt = Date.now();
    if (!lastConnectedAt || startedAt - lastConnectedAt < DAEMON_WATCHDOG_CONNECT_GRACE_MS) {
      return;
    }
    watchdogProbeInFlight = true;
    try {
      const probe = await probeAgentPresence();
      const now = Date.now();
      const lastWsHealthAt = Math.max(lastPongAt || 0, lastInboundAt || 0, lastConnectedAt || 0);
      const staleWs = !lastWsHealthAt || now - lastWsHealthAt > DAEMON_WATCHDOG_STALE_WS_MS;

      if (!probe.ok) {
        if (now - watchdogLastProbeErrorAt >= DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS) {
          watchdogLastProbeErrorAt = now;
          logError(`[watchdog] agent presence probe failed: ${probe.error}`);
        }
        if (staleWs) {
          requestWatchdogSelfHeal("stale_ws_health", {
            probeAt: lastPresenceCheckAt,
            probeStatus: probe.status,
            probeError: probe.error,
            lastWsHealthAt,
            staleForMs: now - lastWsHealthAt,
          });
        }
        return;
      }

      if (!probe.selfOnline && now - watchdogLastPresenceMismatchAt >= DAEMON_WATCHDOG_RECONNECT_COOLDOWN_MS) {
        watchdogLastPresenceMismatchAt = now;
        logError(`[watchdog] agent presence probe did not include current host; skipping self-heal to avoid false positives on non-sticky HTTP/WS deployments (${formatWatchdogExtra({
          agentCount: probe.agentCount,
          probeAt: lastPresenceCheckAt,
        })})`);
      }

      if (staleWs) {
        requestWatchdogSelfHeal("stale_ws_health", {
          agentCount: probe.agentCount,
          lastWsHealthAt,
          staleForMs: now - lastWsHealthAt,
          probeAt: lastPresenceCheckAt,
        });
      }
    } finally {
      watchdogProbeInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-update: periodic version check (P1) + safe-window update (P2)
  // ---------------------------------------------------------------------------

  const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

  async function checkForUpdate() {
    if (!AUTO_UPDATE_ENABLED || cliVersion === "unknown") return;
    const now = Date.now();
    if (now - lastVersionCheckAt < VERSION_CHECK_INTERVAL_MS) return;
    lastVersionCheckAt = now;
    try {
      const latest = await fetchLatestVersionFn();
      if (!latest || !SEMVER_RE.test(latest)) return; // reject malformed versions
      if (isNewerVersionFn(latest, cliVersion)) {
        if (latestKnownVersion !== latest) {
          log(`[auto-update] New version available: ${cliVersion} -> ${latest}`);
        }
        latestKnownVersion = latest;
        updateAvailable = true;
      } else {
        updateAvailable = false;
        latestKnownVersion = latest;
      }
    } catch {
      /* silent — non-critical */
    }
  }

  const AUTO_UPDATE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown after failure
  let lastAutoUpdateFailAt = 0;

  function hasActiveTasks() {
    return activeTaskProcesses.size > 0 || activePtySessions.size > 0;
  }

  async function tryAutoUpdate() {
    if (!AUTO_UPDATE_ENABLED || !updateAvailable || !latestKnownVersion) return;
    if (autoUpdateInProgress || daemonShuttingDown) return;
    if (hasActiveTasks()) return;
    if (!isInUpdateWindowFn(UPDATE_WINDOW)) return;
    if (Date.now() - lastAutoUpdateFailAt < AUTO_UPDATE_COOLDOWN_MS) return;

    autoUpdateInProgress = true;
    log(`[auto-update] Starting: ${cliVersion} -> ${latestKnownVersion}`);
    try {
      await performAutoUpdate(latestKnownVersion);
    } catch (err) {
      logError(`[auto-update] Failed: ${err?.message || err}`);
      lastAutoUpdateFailAt = Date.now();
    } finally {
      autoUpdateInProgress = false;
    }
  }

  function runInstallCommand(pm, pkgSpec) {
    return new Promise((resolve) => {
      let cmd, args;
      switch (pm) {
        case "pnpm":
          cmd = "pnpm";
          args = ["add", "-g", pkgSpec];
          break;
        case "yarn":
          cmd = "yarn";
          args = ["global", "add", pkgSpec];
          break;
        default:
          cmd = "npm";
          args = ["install", "-g", pkgSpec];
          break;
      }
      let stdout = "";
      let stderr = "";
      const child = spawnFn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 120_000);
      child.stdout?.on("data", (d) => {
        if (stdout.length < 4000) stdout += d.toString().slice(0, 2000);
      });
      child.stderr?.on("data", (d) => {
        if (stderr.length < 4000) stderr += d.toString().slice(0, 2000);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ success: code === 0, code, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, code: -1, stdout, stderr: err.message });
      });
    });
  }

  function runCommand(command, args, options = 120_000) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const normalizedOptions =
        typeof options === "number"
          ? { timeoutMs: options }
          : (options || {});
      const child = spawnFn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: normalizedOptions.env || { ...process.env },
        cwd: normalizedOptions.cwd || process.cwd(),
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, normalizedOptions.timeoutMs ?? 120_000);
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < 4000) stdout += chunk.toString().slice(0, 2000);
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 4000) stderr += chunk.toString().slice(0, 2000);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ success: code === 0, code, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, code: -1, stdout, stderr: err.message || String(err) });
      });
    });
  }

  function runBufferedCommand(command, args, options = {}) {
    return runCommand(command, args, options);
  }

  async function readInstalledCliVersion() {
    const commandAttempts = versionCheckScript
      ? [{
          command: process.execPath,
          args: [versionCheckScript, ...versionCheckArgs],
        }]
      : [{
          command: "conductor",
          args: ["--version"],
        }];

    for (const attempt of commandAttempts) {
      const commandResult = await runCommand(attempt.command, attempt.args, 15_000);
      const combinedOutput = `${commandResult.stdout}\n${commandResult.stderr}`.trim();
      const match = combinedOutput.match(/conductor version ([^\s]+)/);
      if (match?.[1]) {
        return match[1];
      }
    }

    let pkgPath;
    try {
      pkgPath = moduleRequire.resolve(`${PACKAGE_NAME}/package.json`);
    } catch {
      pkgPath = path.join(installedPackageRoot, "package.json");
    }
    const newPkg = JSON.parse(readFileSyncFn(pkgPath, "utf-8"));
    return newPkg.version || null;
  }

  async function installCliVersion(targetVersion, tag) {
    const pm = detectPackageManagerFn({
      launcherPath: restartLauncherScript || versionCheckScript,
      packageRoot: installedPackageRoot,
    });
    const pkgSpec = `${PACKAGE_NAME}@${targetVersion}`;

    if (pm === "pnpm") {
      log(`[${tag}] Preparing pnpm native dependency allowlist for node-pty`);
      await ensurePnpmOnlyBuiltDependencies({
        runCommand: runBufferedCommand,
        dependencies: ["node-pty"],
        global: true,
      });
    }

    log(`[${tag}] Installing ${pkgSpec} via ${pm}...`);
    const result = await runInstallCommand(pm, pkgSpec);
    if (!result.success) {
      throw new Error(
        `Install failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 200)}`
      );
    }

    try {
      const installedVersion = await readInstalledCliVersion();
      if (installedVersion !== targetVersion) {
        throw new Error(
          `Version mismatch after install: expected ${targetVersion}, got ${installedVersion}`
        );
      }
    } catch (verifyErr) {
      throw new Error(`Version verification failed: ${verifyErr?.message || verifyErr}`);
    }

    try {
      await repairAndVerifyGlobalNodePty({
        packageManager: pm,
        packageName: PACKAGE_NAME,
        runCommand: runBufferedCommand,
        nodeExecutable: process.execPath,
      });
    } catch (verifyErr) {
      throw new Error(`Native dependency verification failed: ${verifyErr?.message || verifyErr}`);
    }

    log(`[${tag}] Installed and verified ${targetVersion} (node-pty OK)`);
  }

  async function restartDaemonProcess(reason, { allowForegroundRespawn = false } = {}) {
    const shouldRespawn = isBackgroundProcess || allowForegroundRespawn;
    if (shouldRespawn && !restartLauncherScript) {
      throw new Error("Missing daemon restart launcher script");
    }

    let logFd = null;
    if (shouldRespawn) {
      try {
        mkdirSyncFn(DAEMON_LOG_DIR, { recursive: true });
      } catch {
        /* ignore */
      }
      logFd = fs.openSync(DAEMON_LOG_PATH, "a");
      if (!isBackgroundProcess) {
        log(
          `[${reason}] Foreground daemon will be respawned in background. Logs: ${DAEMON_LOG_PATH}`
        );
      }
    }

    await shutdownDaemon(reason);

    if (shouldRespawn) {
      const handoffToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const handoffExpiresAt = Date.now() + 15_000;
      try {
        writeLockHandoff({
          handoffToken,
          handoffFromPid: process.pid,
          handoffExpiresAt,
        });
        const child = spawnFn(process.execPath, [restartLauncherScript, ...restartLauncherArgs], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: {
            ...process.env,
            CONDUCTOR_LOCK_HANDOFF_TOKEN: handoffToken,
            CONDUCTOR_LOCK_HANDOFF_FROM_PID: String(process.pid),
            CONDUCTOR_LOCK_HANDOFF_EXPIRES_AT: String(handoffExpiresAt),
          },
        });
        child.unref();
        log(`[${reason}] New daemon spawned (PID ${child.pid})`);
      } catch (error) {
        cleanupLock();
        exitFn(1);
        throw new Error(`Restart failed after shutdown: ${error?.message || error}`);
      } finally {
        if (typeof logFd === "number") {
          fs.closeSync(logFd);
        }
      }
    } else {
      log(`[${reason}] Foreground mode — please restart the daemon manually.`);
    }
    exitFn(0);
  }

  async function performAutoUpdate(targetVersion) {
    await installCliVersion(targetVersion, "auto-update");

    if (!AUTO_UPDATE_RESPAWN_ENABLED) {
      log(
        `[auto-update] Installed ${targetVersion}. Respawn is gated off (set CONDUCTOR_AUTO_UPDATE_RESPAWN=true to enable); new version will take effect on next manual restart.`
      );
      return;
    }

    // Re-check active tasks — a task may have arrived during the install
    if (hasActiveTasks()) {
      log("[auto-update] Active tasks appeared during install; aborting restart (will retry later)");
      return;
    }

    log(`[auto-update] Restarting daemon after upgrade to ${targetVersion}...`);
    await restartDaemonProcess("auto-update");
  }

  async function handleRestartDaemon(payload) {
    const requestId = payload?.request_id ? String(payload.request_id) : "";
    const targetVersionRaw = payload?.target_version
      ? String(payload.target_version).trim()
      : "latest";

    if (daemonShuttingDown) {
      log(`[restart_daemon] Ignored (${requestId}): daemon already shutting down`);
      sendAgentCommandAck({
        requestId,
        eventType: "restart_daemon",
        accepted: false,
      }).catch(() => {});
      return;
    }
    if (autoUpdateInProgress) {
      log(`[restart_daemon] Ignored (${requestId}): restart already in progress`);
      sendAgentCommandAck({
        requestId,
        eventType: "restart_daemon",
        accepted: false,
      }).catch(() => {});
      return;
    }

    autoUpdateInProgress = true;
    try {
      log(
        `[restart_daemon] Received (request_id=${requestId}, target=${targetVersionRaw}, current=${cliVersion})`
      );
      // Ack receipt before blocking work so the server learns this daemon
      // accepted the command even if install/shutdown takes several seconds.
      await sendAgentCommandAck({
        requestId,
        eventType: "restart_daemon",
        accepted: true,
      }).catch(() => {});

      let resolvedTarget = null;
      if (targetVersionRaw === "latest") {
        try {
          const latest = await fetchLatestVersionFn();
          if (latest && SEMVER_RE.test(latest) && isNewerVersionFn(latest, cliVersion)) {
            resolvedTarget = latest;
          } else if (latest) {
            log(`[restart_daemon] Already on latest (${cliVersion}); plain restart`);
          }
        } catch (err) {
          logError(`[restart_daemon] Failed to fetch latest version: ${err?.message || err}`);
        }
      } else if (SEMVER_RE.test(targetVersionRaw) && targetVersionRaw !== cliVersion) {
        resolvedTarget = targetVersionRaw;
      }

      if (resolvedTarget) {
        try {
          await installCliVersion(resolvedTarget, "restart_daemon");
        } catch (err) {
          logError(
            `[restart_daemon] Install failed, falling back to plain restart: ${err?.message || err}`
          );
        }
      }

      try {
        await restartDaemonProcess("restart_daemon", { allowForegroundRespawn: true });
      } catch (err) {
        logError(`[restart_daemon] Restart failed after shutdown; exiting: ${err?.message || err}`);
        cleanupLock();
        exitFn(1);
      }
    } finally {
      // Clear in case restartDaemonProcess never actually exited (e.g. in tests
      // where exitFn is mocked). In real runtime exitFn is process.exit, so
      // this line is unreachable on both success and failure paths.
      autoUpdateInProgress = false;
    }
  }

  const getActiveTaskIds = () => [
    ...new Set([...activeTaskProcesses.keys(), ...activePtySessions.keys()]),
  ];

  async function recoverStaleTasks() {
    try {
      const response = await fetchFn(`${BACKEND_HTTP}/api/tasks`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AGENT_TOKEN}`,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        logError(`Failed to recover stale tasks: HTTP ${response.status}`);
        return;
      }
      markBackendHttpSuccess();

      const tasks = await response.json();
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return;
      }

      const staleTasks = tasks.filter((task) => {
        const status = String(task?.status || "").trim().toLowerCase();
        const agentHost = String(task?.agent_host || "").trim();
        return agentHost === AGENT_NAME && (status === "unknown" || status === "running");
      });

      if (staleTasks.length === 0) {
        return;
      }

      await Promise.all(
        staleTasks.map(async (task) => {
          const taskId = task?.id;
          if (!taskId) return;
          const patchResp = await fetchFn(`${BACKEND_HTTP}/api/tasks/${taskId}`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${AGENT_TOKEN}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ status: "killed" }),
          });
          if (!patchResp.ok) {
            logError(`Failed to mark stale task ${taskId} as killed: HTTP ${patchResp.status}`);
          } else {
            markBackendHttpSuccess();
          }
        }),
      );

      log(`Recovered ${staleTasks.length} stale task(s) to killed`);
    } catch (error) {
      logError(`recoverStaleTasks error: ${error?.message || error}`);
    }
  }

  async function reconcileAssignedTasks() {
    try {
      const response = await fetchFn(`${BACKEND_HTTP}/api/tasks`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AGENT_TOKEN}`,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        logError(`Failed to reconcile tasks: HTTP ${response.status}`);
        return;
      }
      markBackendHttpSuccess();
      const tasks = await response.json();
      if (!Array.isArray(tasks)) {
        return;
      }
      const localTaskIds = new Set(getActiveTaskIds());
      const assigned = tasks.filter((task) => {
        const agentHost = String(task?.agent_host || "").trim();
        const status = String(task?.status || "").trim().toLowerCase();
        return agentHost === AGENT_NAME && (status === "unknown" || status === "running");
      });

      let killedCount = 0;
      for (const task of assigned) {
        const taskId = String(task?.id || "");
        if (!taskId) continue;
        if (localTaskIds.has(taskId)) {
          continue;
        }
        const patchResp = await fetchFn(`${BACKEND_HTTP}/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${AGENT_TOKEN}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "killed" }),
        });
        if (patchResp.ok) {
          killedCount += 1;
          markBackendHttpSuccess();
        } else {
          logError(`Failed to reconcile stale task ${taskId}: HTTP ${patchResp.status}`);
        }
      }

      if (assigned.length || localTaskIds.size) {
        log(
          `Reconciled tasks after reconnect: backendAssigned=${assigned.length} localActive=${localTaskIds.size} markedKilled=${killedCount}`,
        );
      }
    } catch (error) {
      logError(`reconcileAssignedTasks error: ${error?.message || error}`);
    }
  }

  async function sendAgentResume(isReconnect = false) {
    await client.sendJson({
      type: "agent_resume",
      payload: {
        active_tasks: getActiveTaskIds(),
        source: "conductor-daemon",
        metadata: { is_reconnect: Boolean(isReconnect) },
      },
    });
  }

  function markRequestSeen(requestId) {
    if (!requestId) return true;
    if (seenCommandRequestIds.has(requestId)) {
      return false;
    }
    seenCommandRequestIds.add(requestId);
    if (seenCommandRequestIds.size > 2000) {
      const first = seenCommandRequestIds.values().next();
      if (!first.done) {
        seenCommandRequestIds.delete(first.value);
        completedCommandRequestAckResults.delete(first.value);
      }
    }
    return true;
  }

  function rememberCommandRequestAckResult(requestId, accepted) {
    if (!requestId) return;
    completedCommandRequestAckResults.set(String(requestId), Boolean(accepted));
    if (completedCommandRequestAckResults.size > 2000) {
      const first = completedCommandRequestAckResults.keys().next();
      if (!first.done) {
        completedCommandRequestAckResults.delete(first.value);
      }
    }
  }

  function sendAgentCommandAck({ requestId, taskId, eventType, accepted = true }) {
    if (!requestId) return Promise.resolve();
    return client.sendJson({
      type: "agent_command_ack",
      payload: {
        request_id: String(requestId),
        task_id: taskId ? String(taskId) : undefined,
        event_type: eventType,
        accepted: Boolean(accepted),
      },
    });
  }

  function sendTerminalEvent(type, payload) {
    return client.sendJson({
      type,
      payload,
    });
  }

  function reportTaskWorktreeCleanupResult({
    requestId,
    taskId,
    worktreeBranch = null,
    removedPath = null,
    cleaned = true,
    error = null,
  }) {
    if (!requestId || !taskId) return Promise.resolve();
    return client.sendJson({
      type: "task_worktree_cleanup_result",
      payload: {
        request_id: String(requestId),
        task_id: String(taskId),
        daemon_host: AGENT_NAME || os.hostname(),
        worktree_branch: worktreeBranch || undefined,
        removed_path: removedPath || undefined,
        cleaned: Boolean(cleaned),
        error: error ? String(error) : null,
        cleaned_at: new Date().toISOString(),
      },
    });
  }

  function sendPtyTransportStatus(payload) {
    return client.sendJson({
      type: "pty_transport_status",
      payload,
    });
  }

  function rejectCreateTaskDuringShutdown(payload, { sendAck = true } = {}) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    const projectId = payload?.project_id ? String(payload.project_id) : "";
    const requestId = payload?.request_id ? String(payload.request_id) : "";
    log(`Rejecting create_task for ${taskId || "unknown"}: daemon is shutting down`);
    if (sendAck) {
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_task",
        accepted: false,
      }).catch(() => {});
    }
    if (!taskId || !projectId) {
      return;
    }
    client
      .sendJson({
        type: "task_status_update",
        payload: {
          task_id: taskId,
          project_id: projectId,
          status: "KILLED",
          summary: "daemon shutting down",
        },
      })
      .catch((err) => {
        logError(`Failed to report shutdown rejection for ${taskId}: ${err?.message || err}`);
      });
  }

  function rejectCreatePtyTaskDuringShutdown(payload, { sendAck = true } = {}) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    const projectId = payload?.project_id ? String(payload.project_id) : "";
    const ptySessionId = payload?.pty_session_id ? String(payload.pty_session_id) : null;
    const requestId = payload?.request_id ? String(payload.request_id) : "";
    log(`Rejecting create_pty_task for ${taskId || "unknown"}: daemon is shutting down`);
    if (sendAck) {
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_pty_task",
        accepted: false,
      }).catch(() => {});
    }
    sendTerminalEvent("terminal_error", {
      task_id: taskId || undefined,
      project_id: projectId || undefined,
      pty_session_id: ptySessionId,
      message: "daemon shutting down",
    }).catch((err) => {
      logError(`Failed to report PTY shutdown rejection for ${taskId || "unknown"}: ${err?.message || err}`);
    });
  }

  function rejectCreatePtyTaskUnavailable(payload) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    const projectId = payload?.project_id ? String(payload.project_id) : "";
    const ptySessionId = payload?.pty_session_id ? String(payload.pty_session_id) : null;
    const requestId = payload?.request_id ? String(payload.request_id) : "";
    const message = ptyTaskCapabilityError
      ? `pty runtime unavailable: ${ptyTaskCapabilityError}`
      : "pty runtime unavailable";
    log(`Rejecting create_pty_task for ${taskId || "unknown"}: ${message}`);
    sendAgentCommandAck({
      requestId,
      taskId,
      eventType: "create_pty_task",
      accepted: false,
    }).catch(() => {});
    sendTerminalEvent("terminal_error", {
      task_id: taskId || undefined,
      project_id: projectId || undefined,
      pty_session_id: ptySessionId,
      message,
    }).catch((err) => {
      logError(`Failed to report PTY capability rejection for ${taskId || "unknown"}: ${err?.message || err}`);
    });
  }

  function sendPtyTransportSignal(payload) {
    return client.sendJson({
      type: "pty_transport_signal",
      payload,
    });
  }

  function logRtcAvailabilityOnce(key, message) {
    if (rtcAvailabilityLogKey === key) {
      return;
    }
    rtcAvailabilityLogKey = key;
    log(message);
  }

  async function resolveRtcImplementation() {
    if (RTC_DIRECT_DISABLED) {
      logRtcAvailabilityOnce(
        "disabled",
        "PTY direct RTC runtime disabled by CONDUCTOR_DISABLE_PTY_DIRECT_RTC=1; relay fallback only",
      );
      return null;
    }

    if (createRtcPeerConnection) {
      logRtcAvailabilityOnce("ready:deps", "PTY direct RTC runtime ready via injected peer connection");
      return {
        source: "deps.createRtcPeerConnection",
        createPeerConnection: (...args) => createRtcPeerConnection(...args),
      };
    }

    if (typeof globalThis.RTCPeerConnection === "function") {
      logRtcAvailabilityOnce("ready:global", "PTY direct RTC runtime ready via globalThis.RTCPeerConnection");
      return {
        source: "globalThis.RTCPeerConnection",
        createPeerConnection: (...args) => new globalThis.RTCPeerConnection(...args),
      };
    }

    if (!rtcImplementationPromise) {
      rtcImplementationPromise = (async () => {
        for (const moduleName of RTC_MODULE_CANDIDATES) {
          try {
            const mod = await importOptionalModule(moduleName);
            const PeerConnectionCtor =
              mod?.RTCPeerConnection ||
              mod?.default?.RTCPeerConnection ||
              mod?.default;
            if (typeof PeerConnectionCtor === "function") {
              return {
                source: moduleName,
                createPeerConnection: (...args) => new PeerConnectionCtor(...args),
              };
            }
          } catch {
            // Try next implementation.
          }
        }
        return null;
      })();
    }

    const rtc = await rtcImplementationPromise;
    if (rtc) {
      logRtcAvailabilityOnce(`ready:${rtc.source}`, `PTY direct RTC runtime ready via ${rtc.source}`);
      return rtc;
    }

    logRtcAvailabilityOnce(
      "unavailable",
      `PTY direct RTC runtime unavailable; install optional dependency ${DEFAULT_RTC_MODULE_CANDIDATES[0]} or keep relay fallback`,
    );
    return null;
  }

  function cleanupPtyRtcTransport(taskId, expectedSessionId = null) {
    const current = activePtyRtcTransports.get(taskId);
    if (!current) {
      return;
    }
    if (expectedSessionId && current.sessionId !== expectedSessionId) {
      return;
    }
    try {
      current.channel?.close?.();
    } catch {}
    try {
      current.peer?.close?.();
    } catch {}
    activePtyRtcTransports.delete(taskId);
  }

  async function startPtyRtcNegotiation(taskId, sessionId, connectionId, offerDescription) {
    const record = activePtySessions.get(taskId);
    if (!record) {
      return { ok: false, reason: "terminal_session_not_found" };
    }

    const rtc = await resolveRtcImplementation();
    if (!rtc) {
      return { ok: false, reason: "direct_transport_not_supported" };
    }

    cleanupPtyRtcTransport(taskId);

    try {
      const peer = rtc.createPeerConnection();
      const transport = {
        taskId,
        sessionId,
        connectionId,
        peer,
        channel: null,
      };
      activePtyRtcTransports.set(taskId, transport);

      peer.ondatachannel = (event) => {
        transport.channel = event?.channel || null;
        if (transport.channel) {
          transport.channel.onmessage = (messageEvent) => {
            try {
              const raw =
                typeof messageEvent?.data === "string"
                  ? messageEvent.data
                  : Buffer.isBuffer(messageEvent?.data)
                    ? messageEvent.data.toString("utf8")
                    : String(messageEvent?.data ?? "");
              const parsed = JSON.parse(raw);
              handleDirectTransportPayload(taskId, sessionId, connectionId, parsed);
            } catch (error) {
              logError(`Failed to handle PTY direct channel message for ${taskId}: ${error?.message || error}`);
            }
          };
          transport.channel.onopen = () => {
            sendPtyTransportStatus({
              task_id: taskId,
              session_id: sessionId,
              connection_id: connectionId,
              transport_state: "direct",
              transport_policy: "direct_preferred",
              writer_connection_id: connectionId,
              direct_candidate: true,
            }).catch((err) => {
              logError(`Failed to report direct PTY transport status for ${taskId}: ${err?.message || err}`);
            });
          };
          transport.channel.onclose = () => {
            sendPtyTransportStatus({
              task_id: taskId,
              session_id: sessionId,
              connection_id: connectionId,
              transport_state: "fallback_relay",
              transport_policy: "direct_preferred",
              writer_connection_id: connectionId,
              direct_candidate: false,
              reason: "direct_channel_closed",
            }).catch((err) => {
              logError(`Failed to report PTY transport fallback for ${taskId}: ${err?.message || err}`);
            });
            cleanupPtyRtcTransport(taskId, sessionId);
          };
        }
      };

      peer.onicecandidate = (event) => {
        if (!event?.candidate) {
          return;
        }
        sendPtyTransportSignal({
          task_id: taskId,
          session_id: sessionId,
          connection_id: connectionId,
          signal_type: "ice_candidate",
          candidate: typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate,
        }).catch((err) => {
          logError(`Failed to report PTY ICE candidate for ${taskId}: ${err?.message || err}`);
        });
      };

      await peer.setRemoteDescription({
        type: "offer",
        sdp: offerDescription.sdp,
      });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      await sendPtyTransportSignal({
        task_id: taskId,
        session_id: sessionId,
        connection_id: connectionId,
        signal_type: "answer",
        description: {
          type: answer.type,
          sdp: answer.sdp,
        },
      });
      await sendPtyTransportStatus({
        task_id: taskId,
        session_id: sessionId,
        connection_id: connectionId,
        transport_state: "negotiating",
        transport_policy: "direct_preferred",
        writer_connection_id: connectionId,
        direct_candidate: true,
      });

      return { ok: true };
    } catch (error) {
      cleanupPtyRtcTransport(taskId, sessionId);
      return {
        ok: false,
        reason: error?.message || "rtc_negotiation_failed",
      };
    }
  }

  function resolvePtyLaunchSpec(launchConfig, fallbackCwd) {
    const normalizedLaunchConfig = normalizeLaunchConfig(launchConfig);
    const entrypointType =
      normalizeOptionalString(normalizedLaunchConfig.entrypoint_type) ||
      normalizeOptionalString(normalizedLaunchConfig.entrypointType) ||
      (normalizeOptionalString(normalizedLaunchConfig.tool_preset) ||
      normalizeOptionalString(normalizedLaunchConfig.toolPreset)
        ? "tool_preset"
        : "shell");
    const preferredShell = resolveDefaultPtyShell({
      explicitShell: normalizedLaunchConfig.shell,
      envShell: process.env.SHELL,
      comspec: process.env.COMSPEC,
      platform: process.platform,
      existsSync: existsSyncFn,
    });
    const cwd =
      normalizeOptionalString(normalizedLaunchConfig.cwd) ||
      fallbackCwd;
    const env = normalizeTerminalEnv(normalizedLaunchConfig.env);
    const cols = normalizePositiveInt(
      normalizedLaunchConfig.cols ?? normalizedLaunchConfig.columns,
      DEFAULT_TERMINAL_COLS,
    );
    const rows = normalizePositiveInt(
      normalizedLaunchConfig.rows,
      DEFAULT_TERMINAL_ROWS,
    );

    if (entrypointType === "tool_preset") {
      const toolPreset =
        normalizeOptionalString(normalizedLaunchConfig.tool_preset) ||
        normalizeOptionalString(normalizedLaunchConfig.toolPreset) ||
        SUPPORTED_BACKENDS[0] ||
        "codex";
      const cliCommand = ALLOW_CLI_LIST[toolPreset];
      if (!cliCommand) {
        throw new Error(`Unsupported tool preset: ${toolPreset}`);
      }
      return {
        entrypointType,
        toolPreset,
        command: preferredShell,
        args: ["-lc", cliCommand],
        shell: preferredShell,
        cwd,
        env,
        cols,
        rows,
      };
    }

    if (entrypointType === "custom") {
      const command = normalizeOptionalString(normalizedLaunchConfig.command);
      if (!command) {
        throw new Error("launch_config.command is required for custom entrypoint");
      }
      const args = Array.isArray(normalizedLaunchConfig.args)
        ? normalizedLaunchConfig.args.filter((value) => typeof value === "string")
        : [];
      return {
        entrypointType,
        toolPreset: null,
        command,
        args,
        shell: preferredShell,
        cwd,
        env,
        cols,
        rows,
      };
    }

    return {
      entrypointType: "shell",
      toolPreset: null,
      command: preferredShell,
      args: ["-l"],
      shell: preferredShell,
      cwd,
      env,
      cols,
      rows,
    };
  }

  function getTerminalChunkByteLength(data) {
    return Buffer.byteLength(data, "utf8");
  }

  function trimTerminalChunkToTailBytes(data, maxBytes) {
    const encoded = Buffer.from(data, "utf8");
    if (encoded.length <= maxBytes) {
      return data;
    }
    const tail = encoded.subarray(encoded.length - maxBytes);
    let start = 0;
    while (start < tail.length && (tail[start] & 0b1100_0000) === 0b1000_0000) {
      start += 1;
    }
    return tail.subarray(start).toString("utf8");
  }

  function bufferTerminalOutput(record, data) {
    record.outputSeq += 1;
    let bufferedData = typeof data === "string" ? data : String(data ?? "");
    let byteLength = getTerminalChunkByteLength(bufferedData);
    if (byteLength > TERMINAL_RING_BUFFER_MAX_BYTES) {
      bufferedData = trimTerminalChunkToTailBytes(bufferedData, TERMINAL_RING_BUFFER_MAX_BYTES);
      byteLength = getTerminalChunkByteLength(bufferedData);
    }
    record.ringBuffer.push({ seq: record.outputSeq, data: bufferedData, byteLength });
    record.ringBufferByteLength += byteLength;
    while (record.ringBufferByteLength > TERMINAL_RING_BUFFER_MAX_BYTES && record.ringBuffer.length > 0) {
      const removed = record.ringBuffer.shift();
      record.ringBufferByteLength -= removed?.byteLength ?? 0;
    }
    return record.outputSeq;
  }

  function buildTerminalResumeSnapshot(record) {
    if (!record || !Array.isArray(record.ringBuffer) || record.ringBuffer.length === 0) {
      return {
        lastSeq: normalizeNonNegativeInt(record?.outputSeq, 0),
        data: "",
        truncated: false,
      };
    }
    const joinedData = record.ringBuffer.map((chunk) => chunk?.data || "").join("");
    const trimmedData = trimTerminalChunkToTailBytes(joinedData, TERMINAL_RESUME_SNAPSHOT_MAX_BYTES);
    return {
      lastSeq: normalizeNonNegativeInt(record.outputSeq, 0),
      data: trimmedData,
      truncated: getTerminalChunkByteLength(trimmedData) < getTerminalChunkByteLength(joinedData),
    };
  }

  function sendDirectPtyPayload(taskId, payload) {
    const transport = activePtyRtcTransports.get(taskId);
    const channel = transport?.channel;
    if (!channel || channel.readyState !== "open" || typeof channel.send !== "function") {
      return false;
    }
    try {
      channel.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      logError(`Failed to send PTY direct payload for ${taskId}: ${error?.message || error}`);
      if (transport) {
        sendPtyTransportStatus({
          task_id: taskId,
          session_id: transport.sessionId,
          connection_id: transport.connectionId,
          transport_state: "fallback_relay",
          transport_policy: "direct_preferred",
          writer_connection_id: transport.connectionId,
          direct_candidate: false,
          reason: "direct_channel_send_failed",
        }).catch((err) => {
          logError(`Failed to report PTY direct send fallback for ${taskId}: ${err?.message || err}`);
        });
      }
      cleanupPtyRtcTransport(taskId);
      return false;
    }
  }

  function handleDirectTransportPayload(taskId, sessionId, connectionId, payload) {
    const transport = activePtyRtcTransports.get(taskId);
    if (
      !transport ||
      transport.sessionId !== sessionId ||
      transport.connectionId !== connectionId
    ) {
      return;
    }
    if (payload?.type === "terminal_input" && payload.payload) {
      handleTerminalInput(payload.payload);
      return;
    }
    if (payload?.type === "terminal_resize" && payload.payload) {
      handleTerminalResize(payload.payload);
    }
  }

  function attachPtyStreamHandlers(taskId, record) {
    const writeLogChunk = (chunk) => {
      if (record.logStream) {
        record.logStream.write(chunk);
      }
    };

    record.pty.onData((data) => {
      writeLogChunk(data);
      const seq = bufferTerminalOutput(record, data);
      const latencySample = record.pendingLatencySample
        ? {
            client_input_seq: record.pendingLatencySample.clientInputSeq ?? undefined,
            client_sent_at: record.pendingLatencySample.clientSentAt ?? undefined,
            server_received_at: record.pendingLatencySample.serverReceivedAt ?? undefined,
            daemon_received_at: record.pendingLatencySample.daemonReceivedAt,
            first_output_at: new Date().toISOString(),
            daemon_input_to_first_output_ms: Math.max(0, Date.now() - record.pendingLatencySample.daemonReceivedAtMs),
          }
        : undefined;
      record.pendingLatencySample = null;
      const outputPayload = {
        task_id: taskId,
        project_id: record.projectId,
        pty_session_id: record.ptySessionId,
        seq,
        data,
        ...(latencySample ? { latency_sample: latencySample } : {}),
      };
      sendDirectPtyPayload(taskId, {
        type: "terminal_output",
        payload: outputPayload,
      });
      sendTerminalEvent("terminal_output", outputPayload).catch((err) => {
        logError(`Failed to report terminal_output for ${taskId}: ${err?.message || err}`);
      });
    });

    record.pty.onExit(({ exitCode, signal }) => {
      if (record.stopForceKillTimer) {
        clearTimeout(record.stopForceKillTimer);
      }
      cleanupPtyRtcTransport(taskId);
      activePtySessions.delete(taskId);
      if (record.logStream) {
        const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
        record.logStream.write(
          `[daemon ${ts}] pty exited exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}\n`,
        );
        record.logStream.end();
      }
      const closedAt = new Date().toISOString();
      log(`PTY task ${taskId} exited with code=${exitCode ?? "null"} signal=${signal ?? "null"}`);
      sendTerminalEvent("terminal_exit", {
        task_id: taskId,
        project_id: record.projectId,
        pty_session_id: record.ptySessionId,
        exit_code: exitCode ?? null,
        signal: signal ?? null,
        seq: record.outputSeq,
        closed_at: closedAt,
      }).catch((err) => {
        logError(`Failed to report terminal_exit for ${taskId}: ${err?.message || err}`);
      });
    });
  }

  function resizePty(record, cols, rows) {
    const nextCols = normalizePositiveInt(cols, record.cols || DEFAULT_TERMINAL_COLS);
    const nextRows = normalizePositiveInt(rows, record.rows || DEFAULT_TERMINAL_ROWS);
    record.cols = nextCols;
    record.rows = nextRows;
    if (typeof record.pty.resize === "function") {
      record.pty.resize(nextCols, nextRows);
    }
  }

  async function handleCreatePtyTask(payload) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    const projectId = payload?.project_id ? String(payload.project_id) : "";
    const ptySessionId = payload?.pty_session_id ? String(payload.pty_session_id) : "";
    const requestId = payload?.request_id ? String(payload.request_id) : "";
    const launchConfig = normalizeLaunchConfig(payload?.launch_config);

    if (!taskId || !projectId || !ptySessionId) {
      logError(`Invalid create_pty_task payload: ${JSON.stringify(payload)}`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_pty_task",
        accepted: false,
      }).catch(() => {});
      return;
    }

    if (daemonShuttingDown) {
      rejectCreatePtyTaskDuringShutdown(payload);
      return;
    }

    if (!ptyTaskCapabilityEnabled) {
      rejectCreatePtyTaskUnavailable(payload);
      return;
    }

    if (requestId && !markRequestSeen(requestId)) {
      log(`Duplicate create_pty_task ignored for ${taskId} (request_id=${requestId})`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_pty_task",
        accepted: true,
      }).catch(() => {});
      return;
    }

    if (activeTaskProcesses.has(taskId) || activePtySessions.has(taskId)) {
      log(`Duplicate create_pty_task ignored for ${taskId}: task already active`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_pty_task",
        accepted: true,
      }).catch(() => {});
      return;
    }

    let boundPath = await getProjectLocalPath(projectId);
    if (daemonShuttingDown) {
      rejectCreatePtyTaskDuringShutdown(payload);
      return;
    }
    let taskDir =
      normalizeOptionalString(launchConfig.cwd) ||
      boundPath;
    if (!taskDir) {
      const now = new Date();
      const dayDir = path.join(WORKSPACE_ROOT, formatWorkspaceDate(now));
      const runTimestampPart = formatWorkspaceRunTimestamp(now);
      const taskSuffix = taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || String(process.pid);
      // PTY login shells can exit immediately if their cwd is renamed right after spawn.
      const pendingRunDir = `${runTimestampPart}_pty_${taskSuffix}`;
      taskDir = path.join(dayDir, pendingRunDir);
    }

    try {
      mkdirSyncFn(taskDir, { recursive: true });
    } catch (err) {
      logError(`Failed to create PTY workspace ${taskDir}: ${err?.message || err}`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_pty_task",
        accepted: false,
      }).catch(() => {});
      return;
    }

    let launchSpec;
    try {
      launchSpec = resolvePtyLaunchSpec(launchConfig, taskDir);
    } catch (error) {
      logError(`Failed to resolve PTY launch config for ${taskId}: ${error?.message || error}`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_pty_task",
        accepted: false,
      }).catch(() => {});
      sendTerminalEvent("terminal_error", {
        task_id: taskId,
        project_id: projectId,
        pty_session_id: ptySessionId,
        message: error?.message || String(error),
      }).catch(() => {});
      return;
    }

    sendAgentCommandAck({
      requestId,
      taskId,
      eventType: "create_pty_task",
      accepted: true,
    }).catch((err) => {
      logError(`Failed to report agent_command_ack(create_pty_task) for ${taskId}: ${err?.message || err}`);
    });

    const env = buildPtyTaskEnv(process.env, launchSpec.env);

    const logPath = path.join(launchSpec.cwd, "conductor-terminal.log");
    let logStream;
    try {
      logStream = createWriteStreamFn(logPath, { flags: "a" });
      if (logStream && typeof logStream.on === "function") {
        const logPathSnapshot = logPath;
        logStream.on("error", (err) => {
          logError(`Terminal log stream error (${logPathSnapshot}): ${err?.message || err}`);
        });
      }
    } catch (err) {
      logError(`Failed to open PTY log file ${logPath}: ${err?.message || err}`);
    }

    try {
      const pty = await createPtyFn(launchSpec.command, launchSpec.args, {
        name: "xterm-256color",
        cols: launchSpec.cols,
        rows: launchSpec.rows,
        cwd: launchSpec.cwd,
        env,
      });
      if (daemonShuttingDown) {
        try {
          if (typeof pty?.kill === "function") {
            pty.kill("SIGTERM");
          }
        } catch (killError) {
          logError(`Failed to stop PTY task ${taskId} during shutdown: ${killError?.message || killError}`);
        }
        if (logStream) {
          logStream.end();
        }
        rejectCreatePtyTaskDuringShutdown(payload, { sendAck: false });
        return;
      }
      const resolvedLogPath = path.join(taskDir, "conductor-terminal.log");

      const startedAt = new Date().toISOString();
      const record = {
        kind: "pty",
        pty,
        ptySessionId,
        projectId,
        taskDir,
        logPath: resolvedLogPath,
        logStream,
        cols: launchSpec.cols,
        rows: launchSpec.rows,
        shell: launchSpec.shell,
        startedAt,
        outputSeq: 0,
        ringBuffer: [],
        ringBufferByteLength: 0,
        pendingLatencySample: null,
        stopForceKillTimer: null,
      };
      activePtySessions.set(taskId, record);
      attachPtyStreamHandlers(taskId, record);

      log(`Created PTY task ${taskId} (${launchSpec.entrypointType}) cwd=${launchSpec.cwd}`);
      sendTerminalEvent("terminal_opened", {
        task_id: taskId,
        project_id: projectId,
        pty_session_id: ptySessionId,
        pid: Number.isInteger(pty?.pid) ? pty.pid : null,
        cwd: taskDir,
        shell: launchSpec.shell,
        cols: launchSpec.cols,
        rows: launchSpec.rows,
        started_at: startedAt,
      }).catch((err) => {
        logError(`Failed to report terminal_opened for ${taskId}: ${err?.message || err}`);
      });
    } catch (error) {
      if (logStream) {
        logStream.end();
      }
      logError(`Failed to create PTY task ${taskId}: ${error?.message || error}`);
      sendTerminalEvent("terminal_error", {
        task_id: taskId,
        project_id: projectId,
        pty_session_id: ptySessionId,
        message: error?.message || String(error),
      }).catch(() => {});
    }
  }

  async function handleCleanupTaskWorktree(payload) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    const projectId = payload?.project_id ? String(payload.project_id) : "";
    const requestId = payload?.request_id ? String(payload.request_id) : "";
    const forceCleanup = payload?.force === true;
    const launchConfig = normalizeLaunchConfig(payload?.launch_config);

    if (!taskId || !projectId || !requestId) {
      logError(`Invalid cleanup_task_worktree payload: ${JSON.stringify(payload)}`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "cleanup_task_worktree",
        accepted: false,
      }).catch(() => {});
      return;
    }

    const worktreeConfig = parseTaskWorktreeLaunchConfig(launchConfig);
    if (!worktreeConfig) {
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "cleanup_task_worktree",
        accepted: false,
      }).catch(() => {});
      await reportTaskWorktreeCleanupResult({
        requestId,
        taskId,
        cleaned: false,
        error: "Task does not use an isolated worktree",
      }).catch((error) => {
        logError(`Failed to report task_worktree_cleanup_result for ${taskId}: ${error?.message || error}`);
      });
      return;
    }

    sendAgentCommandAck({
      requestId,
      taskId,
      eventType: "cleanup_task_worktree",
      accepted: true,
    }).catch((error) => {
      logError(`Failed to report agent_command_ack(cleanup_task_worktree) for ${taskId}: ${error?.message || error}`);
    });

    if (activeTaskProcesses.has(taskId) || activePtySessions.has(taskId)) {
      if (forceCleanup) {
        const stopStarted = stopActiveTaskProcess(taskId, {
          reason: "cleanup_task_worktree",
          suppressExitStatusReport: true,
        });
        if (stopStarted) {
          const stopped = await waitForTaskToStop(taskId);
          if (!stopped && (activeTaskProcesses.has(taskId) || activePtySessions.has(taskId))) {
            await reportTaskWorktreeCleanupResult({
              requestId,
              taskId,
              worktreeBranch: worktreeConfig.worktreeBranch,
              cleaned: false,
              error: "Task is still active",
            }).catch((error) => {
              logError(`Failed to report task_worktree_cleanup_result for ${taskId}: ${error?.message || error}`);
            });
            return;
          }
        }
      }
    }

    if (activeTaskProcesses.has(taskId) || activePtySessions.has(taskId)) {
      await reportTaskWorktreeCleanupResult({
        requestId,
        taskId,
        worktreeBranch: worktreeConfig.worktreeBranch,
        cleaned: false,
        error: "Task is still active",
      }).catch((error) => {
        logError(`Failed to report task_worktree_cleanup_result for ${taskId}: ${error?.message || error}`);
      });
      return;
    }

    const worktreeRoot = buildTaskWorktreeRoot(
      worktreeConfig.projectWorkspacePath,
      worktreeConfig.worktreeId,
    );
    if (!isSafeTaskWorktreeRoot(worktreeConfig.projectWorkspacePath, worktreeRoot)) {
      await reportTaskWorktreeCleanupResult({
        requestId,
        taskId,
        worktreeBranch: worktreeConfig.worktreeBranch,
        removedPath: worktreeRoot,
        cleaned: false,
        error: `Refusing to remove unsafe worktree path: ${worktreeRoot}`,
      }).catch((error) => {
        logError(`Failed to report task_worktree_cleanup_result for ${taskId}: ${error?.message || error}`);
      });
      return;
    }
    const worktreeCwd = resolveTaskWorktreeCwd(worktreeRoot, worktreeConfig.projectRelativePath);
    const statusCwd = existsSyncFn(worktreeCwd) ? worktreeCwd : worktreeRoot;

    try {
      if (existsSyncFn(worktreeRoot)) {
        if (!forceCleanup) {
          const { stdout } = await runSpawnProcess(
            "git",
            ["-C", statusCwd, "status", "--porcelain"],
            { cwd: statusCwd },
          );
          if (stdout.trim()) {
            throw new Error("Worktree has uncommitted changes");
          }
        }
        await runSpawnProcess(
          "git",
          [
            "-C",
            worktreeConfig.projectRepoRoot,
            "worktree",
            "remove",
            ...(forceCleanup ? ["--force"] : []),
            worktreeRoot,
          ],
          { cwd: worktreeConfig.projectRepoRoot },
        );
      }

      await reportTaskWorktreeCleanupResult({
        requestId,
        taskId,
        worktreeBranch: worktreeConfig.worktreeBranch,
        removedPath: worktreeRoot,
        cleaned: true,
      });
    } catch (error) {
      await reportTaskWorktreeCleanupResult({
        requestId,
        taskId,
        worktreeBranch: worktreeConfig.worktreeBranch,
        removedPath: worktreeRoot,
        cleaned: false,
        error: error instanceof Error ? error.message : String(error),
      }).catch((reportError) => {
        logError(`Failed to report task_worktree_cleanup_result for ${taskId}: ${reportError?.message || reportError}`);
      });
    }
  }

  async function handleTerminalAttach(payload) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    if (!taskId) return;
    const record = activePtySessions.get(taskId);
    if (!record) {
      sendTerminalEvent("terminal_error", {
        task_id: taskId,
        pty_session_id: payload?.pty_session_id ? String(payload.pty_session_id) : null,
        message: "terminal session not found",
      }).catch(() => {});
      return;
    }

    if (payload?.cols || payload?.rows) {
      resizePty(record, payload?.cols, payload?.rows);
    }

    await sendTerminalEvent("terminal_opened", {
      task_id: taskId,
      project_id: record.projectId,
      pty_session_id: record.ptySessionId,
      pid: Number.isInteger(record.pty?.pid) ? record.pty.pid : null,
      cwd: record.taskDir,
      shell: record.shell,
      cols: record.cols,
      rows: record.rows,
      started_at: record.startedAt,
    }).catch((err) => {
      logError(`Failed to report terminal_opened on attach for ${taskId}: ${err?.message || err}`);
    });

    const lastSeq = normalizePositiveInt(payload?.last_seq ?? payload?.lastSeq, 0);
    const connectionId = normalizeOptionalString(payload?.connection_id ?? payload?.connectionId);
    const resumeStrategy = normalizeTerminalResumeStrategy(payload?.resume_strategy ?? payload?.resumeStrategy);
    if (lastSeq === 0 && resumeStrategy === "snapshot" && connectionId) {
      const snapshot = buildTerminalResumeSnapshot(record);
      await sendTerminalEvent("terminal_snapshot", {
        task_id: taskId,
        project_id: record.projectId,
        pty_session_id: record.ptySessionId,
        connection_id: connectionId,
        last_seq: snapshot.lastSeq,
        data: snapshot.data,
        truncated: snapshot.truncated,
      }).catch((err) => {
        logError(`Failed to report terminal_snapshot for ${taskId}: ${err?.message || err}`);
      });
      return;
    }
    for (const chunk of record.ringBuffer) {
      if (chunk.seq <= lastSeq) continue;
      await sendTerminalEvent("terminal_output", {
        task_id: taskId,
        project_id: record.projectId,
        pty_session_id: record.ptySessionId,
        seq: chunk.seq,
        data: chunk.data,
      }).catch((err) => {
        logError(`Failed to replay terminal_output for ${taskId}: ${err?.message || err}`);
      });
    }
  }

  function handleTerminalInput(payload) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    const data = typeof payload?.data === "string" ? payload.data : "";
    if (!taskId || !data) return;
    const record = activePtySessions.get(taskId);
    if (!record || typeof record.pty.write !== "function") {
      return;
    }
    record.pendingLatencySample = {
      clientInputSeq: normalizeNonNegativeInt(payload?.client_input_seq ?? payload?.clientInputSeq, null),
      clientSentAt: normalizeIsoTimestamp(payload?.client_sent_at ?? payload?.clientSentAt),
      serverReceivedAt: normalizeIsoTimestamp(payload?.server_received_at ?? payload?.serverReceivedAt),
      daemonReceivedAt: new Date().toISOString(),
      daemonReceivedAtMs: Date.now(),
    };
    record.pty.write(data);
  }

  function handleTerminalResize(payload) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    if (!taskId) return;
    const record = activePtySessions.get(taskId);
    if (!record) return;
    resizePty(record, payload?.cols, payload?.rows);
  }

  function handleTerminalDetach(_payload) {
    // PTY sessions stay alive without viewers. Detach is currently a no-op.
  }

  async function handlePtyTransportSignal(payload) {
    const taskId = payload?.task_id ? String(payload.task_id) : "";
    const sessionId = payload?.session_id ? String(payload.session_id) : "";
    const connectionId = payload?.connection_id ? String(payload.connection_id) : "";
    const signalType = payload?.signal_type ? String(payload.signal_type) : "";
    if (!taskId || !connectionId || !signalType) {
      return;
    }

    const record = activePtySessions.get(taskId);
    const description =
      payload?.description && typeof payload.description === "object" && !Array.isArray(payload.description)
        ? payload.description
        : null;
    const candidate =
      payload?.candidate && typeof payload.candidate === "object" && !Array.isArray(payload.candidate)
        ? payload.candidate
        : null;

    if (signalType === "ice_candidate") {
      if (!sessionId) {
        return;
      }
      const transport = activePtyRtcTransports.get(taskId);
      if (
        transport &&
        transport.sessionId === sessionId &&
        transport.connectionId === connectionId &&
        typeof transport.peer?.addIceCandidate === "function" &&
        candidate
      ) {
        try {
          await transport.peer.addIceCandidate(candidate);
        } catch (err) {
          logError(`Failed to apply PTY ICE candidate for ${taskId}: ${err?.message || err}`);
        }
      }
      return;
    }

    if (signalType === "revoke") {
      const transport = activePtyRtcTransports.get(taskId);
      if (transport && transport.connectionId === connectionId) {
        cleanupPtyRtcTransport(taskId);
      }
      return;
    }

    if (signalType === "offer" && description?.type === "offer" && typeof description.sdp === "string") {
      if (!sessionId) {
        return;
      }
      const negotiation = await startPtyRtcNegotiation(taskId, sessionId, connectionId, description);
      if (negotiation.ok) {
        return;
      }
      const reason = negotiation.reason || (record ? "direct_transport_not_supported" : "terminal_session_not_found");
      sendPtyTransportSignal({
        task_id: taskId,
        session_id: sessionId,
        connection_id: connectionId,
        signal_type: "answer_placeholder",
        description: {
          type: "answer",
          mode: "placeholder",
          reason,
        },
      }).catch((err) => {
        logError(`Failed to report pty_transport_signal for ${taskId}: ${err?.message || err}`);
      });
      sendPtyTransportStatus({
        task_id: taskId,
        session_id: sessionId,
        connection_id: connectionId,
        transport_state: "fallback_relay",
        transport_policy: "relay_only",
        writer_connection_id: connectionId,
        direct_candidate: false,
        reason,
      }).catch((err) => {
        logError(`Failed to report pty_transport_status for ${taskId}: ${err?.message || err}`);
      });
      return;
    }

    const reason = record ? "direct_transport_not_supported" : "terminal_session_not_found";
    if (signalType === "direct_request") {
      if (!sessionId) {
        return;
      }
      sendPtyTransportSignal({
        task_id: taskId,
        session_id: sessionId,
        connection_id: connectionId,
        signal_type: "answer_placeholder",
        description: {
          type: "answer",
          mode: "placeholder",
          reason,
        },
      }).catch((err) => {
        logError(`Failed to report pty_transport_signal for ${taskId}: ${err?.message || err}`);
      });
      sendPtyTransportStatus({
        task_id: taskId,
        session_id: sessionId,
        connection_id: connectionId,
        transport_state: "fallback_relay",
        transport_policy: "relay_only",
        writer_connection_id: connectionId,
        direct_candidate: false,
        reason,
      }).catch((err) => {
        logError(`Failed to report pty_transport_status for ${taskId}: ${err?.message || err}`);
      });
    }
  }

  function handleEvent(event) {
    const receivedAt = Date.now();
    lastInboundAt = receivedAt;
    markWatchdogHealthy("inbound", receivedAt);
    if (event.type === "error") {
      const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
      const planLimitMessage = getPlanLimitMessage(payload);
      if (planLimitMessage) {
        logError(planLimitMessage);
        return;
      }
      const backendMessage = typeof payload.message === "string" ? payload.message.trim() : "";
      if (backendMessage) {
        logError(`Backend error: ${backendMessage}`);
      } else {
        logError("Backend returned an error event");
      }
      return;
    }

    if (daemonShuttingDown) {
      if (event.type === "create_task") {
        rejectCreateTaskDuringShutdown(event.payload);
        return;
      }
      if (event.type === "restart_task") {
        const restartMode = event?.payload?.mode ? String(event.payload.mode) : "";
        reportRestartFailure({
          taskId: event?.payload?.target_task_id ? String(event.payload.target_task_id) : "",
          projectId: event?.payload?.project_id ? String(event.payload.project_id) : "",
          requestId: event?.payload?.request_id ? String(event.payload.request_id) : "",
          mode: restartMode,
          error: new Error("daemon shutting down"),
          sendStatus: restartMode !== "refresh_session_inplace",
        });
        return;
      }
      if (event.type === "create_pty_task") {
        rejectCreatePtyTaskDuringShutdown(event.payload);
        return;
      }
      if (event.type === "cleanup_task_worktree") {
        const requestId = event?.payload?.request_id ? String(event.payload.request_id) : "";
        const taskId = event?.payload?.task_id ? String(event.payload.task_id) : "";
        sendAgentCommandAck({
          requestId,
          taskId,
          eventType: "cleanup_task_worktree",
          accepted: false,
        }).catch(() => {});
        void reportTaskWorktreeCleanupResult({
          requestId,
          taskId,
          cleaned: false,
          error: "daemon shutting down",
        });
        return;
      }
    }

    if (event.type === "create_task") {
      void handleCreateTask(event.payload).catch((error) => {
        logError(`Unhandled create_task failure: ${error?.message || error}`);
      });
      return;
    }
    if (event.type === "restart_task") {
      void handleRestartTask(event.payload);
      return;
    }
    if (event.type === "create_pty_task") {
      void handleCreatePtyTask(event.payload);
      return;
    }
    if (event.type === "cleanup_task_worktree") {
      void handleCleanupTaskWorktree(event.payload);
      return;
    }
    if (event.type === "stop_task") {
      handleStopTask(event.payload);
      return;
    }
    if (event.type === "terminal_attach") {
      void handleTerminalAttach(event.payload);
      return;
    }
    if (event.type === "terminal_input") {
      handleTerminalInput(event.payload);
      return;
    }
    if (event.type === "terminal_resize") {
      handleTerminalResize(event.payload);
      return;
    }
    if (event.type === "terminal_detach") {
      handleTerminalDetach(event.payload);
      return;
    }
    if (event.type === "pty_transport_signal") {
      void handlePtyTransportSignal(event.payload);
      return;
    }
    if (event.type === "collect_logs") {
      void handleCollectLogs(event.payload);
      return;
    }
    if (event.type === "validate_project_path") {
      void handleValidateProjectPath(event.payload);
    }
    if (event.type === "ai_manager_request") {
      handleAiManagerRequest(client, aiManagerHandlers, event.payload).catch((error) => {
        logError(`Unhandled ai_manager_request failure: ${error?.message || error}`);
      });
    }
    if (event.type === "restart_daemon") {
      void handleRestartDaemon(event.payload).catch((error) => {
        logError(`Unhandled restart_daemon failure: ${error?.message || error}`);
      });
    }
  }

  function markWatchdogHealthy(signal, at = Date.now()) {
    if (!watchdogAwaitingHealthySignalAt || watchdogHealAttempts === 0) {
      return;
    }
    if (at < watchdogAwaitingHealthySignalAt) {
      return;
    }
    log(
      `[watchdog] Backend websocket healthy again after self-heal via ${signal} (${formatDaemonHealthState({
        connectedAt: lastConnectedAt,
        lastPongAt,
        lastInboundAt,
        lastSuccessfulHttpAt,
        lastPresenceConfirmedAt,
      })})`,
    );
    watchdogAwaitingHealthySignalAt = null;
    watchdogHealAttempts = 0;
  }

  async function handleCollectLogs(payload) {
    const requestId = payload?.request_id ? String(payload.request_id).trim() : "";
    const taskId = payload?.task_id ? String(payload.task_id).trim() : "";
    const collectedAt = new Date().toISOString();

    if (!requestId || !taskId) {
      logError(`Invalid collect_logs payload: ${JSON.stringify(payload)}`);
      return;
    }

    let result;
    try {
      result = await Promise.resolve(
        logCollector.collect(taskId, {
          tailLines: payload?.options?.tail_lines,
          since: payload?.options?.since,
        }),
      );
    } catch (error) {
      result = {
        projectPath: null,
        logPath: null,
        entries: [],
        truncated: false,
        error: `Failed to read log file: ${error?.message || error}`,
        collectedAt,
      };
    }

    try {
      await client.sendJson({
        type: "agent_log_collected",
        payload: {
          request_id: requestId,
          task_id: taskId,
          daemon_host: AGENT_NAME,
          project_path: result.projectPath,
          log_path: result.logPath,
          logs: result.entries,
          truncated: Boolean(result.truncated),
          error: result.error,
          collected_at: result.collectedAt || collectedAt,
        },
      });
    } catch (error) {
      logError(`Failed to report agent_log_collected for ${taskId}: ${error?.message || error}`);
    }
  }

  async function handleValidateProjectPath(payload) {
    const requestId = payload?.request_id ? String(payload.request_id).trim() : "";
    const rawWorkspacePath = payload?.workspace_path ? String(payload.workspace_path).trim() : "";
    const validatedAt = new Date().toISOString();

    if (!requestId || !rawWorkspacePath) {
      logError(`Invalid validate_project_path payload: ${JSON.stringify(payload)}`);
      return;
    }

    let result = {
      workspacePath: null,
      repoRoot: null,
      worktreeBranch: null,
      lastCommit: null,
      fileCount: null,
      error: null,
      errorCode: null,
      validatedAt,
    };

    try {
      const resolvedPath = path.resolve(rawWorkspacePath);
      if (!existsSyncFn(resolvedPath)) {
        result = {
          ...result,
          error: `Workspace path does not exist on daemon ${AGENT_NAME}: ${rawWorkspacePath}`,
          errorCode: "workspace_not_found",
        };
      } else if (!statSyncFn(resolvedPath).isDirectory()) {
        result = {
          ...result,
          error: `Workspace path is not a directory on daemon ${AGENT_NAME}: ${rawWorkspacePath}`,
          errorCode: "workspace_not_directory",
        };
      } else {
        const snapshot = await Promise.resolve(resolveProjectSnapshotFn(resolvedPath));
        const effectiveWorkspace =
          typeof snapshot?.projectRoot === "string" && snapshot.projectRoot.trim()
            ? snapshot.projectRoot.trim()
            : resolvedPath;
        ensureProjectSettingsTemplate(effectiveWorkspace);
        result = {
          ...result,
          workspacePath: effectiveWorkspace,
          repoRoot:
            typeof snapshot?.repoRoot === "string" && snapshot.repoRoot.trim()
              ? snapshot.repoRoot.trim()
              : null,
          worktreeBranch:
            typeof snapshot?.worktreeBranch === "string" && snapshot.worktreeBranch.trim()
              ? snapshot.worktreeBranch.trim()
              : null,
          lastCommit:
            typeof snapshot?.lastCommit === "string" && snapshot.lastCommit.trim()
              ? snapshot.lastCommit.trim()
              : null,
          fileCount:
            typeof snapshot?.fileCount === "number" && Number.isInteger(snapshot.fileCount)
              ? snapshot.fileCount
              : null,
        };
      }
    } catch (error) {
      result = {
        ...result,
        error: `Failed to validate workspace path on daemon ${AGENT_NAME}: ${error?.message || error}`,
        errorCode: "workspace_validation_failed",
      };
    }

    try {
      await client.sendJson({
        type: "project_path_validated",
        payload: {
          request_id: requestId,
          daemon_host: AGENT_NAME,
          workspace_path: result.workspacePath,
          repo_root: result.repoRoot,
          worktree_branch: result.worktreeBranch,
          last_commit: result.lastCommit,
          file_count: result.fileCount,
          error: result.error,
          error_code: result.errorCode,
          validated_at: result.validatedAt,
        },
      });
    } catch (error) {
      logError(`Failed to report project_path_validated for ${rawWorkspacePath}: ${error?.message || error}`);
    }
  }

  function stopActiveTaskProcess(
    taskId,
    {
      reason = "",
      suppressExitStatusReport = false,
    } = {},
  ) {
    const processRecord = activeTaskProcesses.get(taskId);
    const ptyRecord = activePtySessions.get(taskId);
    if ((!processRecord || !processRecord.child) && !ptyRecord) {
      return false;
    }

    if (suppressExitStatusReport) {
      suppressedExitStatusReports.add(taskId);
    }

    const reasonSuffix = reason ? ` (${reason})` : "";
    log(`Stopping task ${taskId}${reasonSuffix}`);

    const activeRecord = processRecord || ptyRecord;
    if (activeRecord?.stopForceKillTimer) {
      clearTimeout(activeRecord.stopForceKillTimer);
      activeRecord.stopForceKillTimer = null;
    }
    if (ptyRecord) {
      cleanupPtyRtcTransport(taskId);
    }

    if (processRecord?.child) {
      try {
        if (typeof processRecord.child.kill === "function") {
          processRecord.child.kill("SIGTERM");
        }
      } catch (error) {
        logError(`Failed to stop task ${taskId}: ${error?.message || error}`);
      }
    } else if (ptyRecord?.pty) {
      try {
        if (typeof ptyRecord.pty.kill === "function") {
          ptyRecord.pty.kill("SIGTERM");
        }
      } catch (error) {
        logError(`Failed to stop PTY task ${taskId}: ${error?.message || error}`);
      }
    }

    activeRecord.stopForceKillTimer = setTimeout(() => {
      const latestProcess = activeTaskProcesses.get(taskId);
      const latestPty = activePtySessions.get(taskId);
      if (latestProcess?.child && processRecord?.child && latestProcess.child === processRecord.child) {
        try {
          if (typeof latestProcess.child.kill === "function") {
            log(`Task ${taskId} did not exit after SIGTERM, sending SIGKILL`);
            latestProcess.child.kill("SIGKILL");
          }
        } catch (error) {
          logError(`Failed to SIGKILL task ${taskId}: ${error?.message || error}`);
        }
        return;
      }
      if (latestPty?.pty && ptyRecord?.pty && latestPty.pty === ptyRecord.pty) {
        try {
          if (typeof latestPty.pty.kill === "function") {
            log(`PTY task ${taskId} did not exit after SIGTERM, sending SIGKILL`);
            latestPty.pty.kill("SIGKILL");
          }
        } catch (error) {
          logError(`Failed to SIGKILL PTY task ${taskId}: ${error?.message || error}`);
        }
      }
    }, STOP_FORCE_KILL_TIMEOUT_MS);

    if (typeof activeRecord.stopForceKillTimer?.unref === "function") {
      activeRecord.stopForceKillTimer.unref();
    }

    return true;
  }

  async function waitForTaskToStop(taskId, timeoutMs = DAEMON_FORCE_STOP_GRACE_MS) {
    const deadline = Date.now() + Math.max(timeoutMs, 0);

    while (activeTaskProcesses.has(taskId) || activePtySessions.has(taskId)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(DAEMON_FORCE_STOP_POLL_INTERVAL_MS, remainingMs)),
      );
    }

    return true;
  }

  function shouldDaemonReportFireChildTerminalStatus(record) {
    return Boolean(record?.forceDaemonTerminalStatusReport) || !Boolean(record?.managedByFireBridge);
  }

  function handleStopTask(payload) {
    const taskId = payload?.task_id;
    if (!taskId) return;
    const requestId = payload?.request_id ? String(payload.request_id) : "";
    if (requestId && !markRequestSeen(requestId)) {
      log(`Duplicate stop_task ignored for ${taskId} (request_id=${requestId})`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "stop_task",
        accepted: true,
      }).catch(() => {});
      return;
    }

    const sendStopAck = (accepted) => {
      if (!requestId) return;
      client
        .sendJson({
          type: "task_stop_ack",
          payload: {
            task_id: taskId,
            request_id: requestId,
            accepted: Boolean(accepted),
          },
        })
        .catch((err) => {
          logError(`Failed to report task_stop_ack for ${taskId}: ${err?.message || err}`);
        });
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "stop_task",
        accepted,
      }).catch((err) => {
        logError(`Failed to report agent_command_ack(stop_task) for ${taskId}: ${err?.message || err}`);
      });
    };

    const processRecord = activeTaskProcesses.get(taskId);
    const ptyRecord = activePtySessions.get(taskId);
    if ((!processRecord || !processRecord.child) && !ptyRecord) {
      log(`Stop requested for task ${taskId}, but no active process found`);
      sendStopAck(false);
      return;
    }

    sendStopAck(true);
    stopActiveTaskProcess(taskId, { reason: payload?.reason });
  }

  async function getProjectLocalPath(projectId) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), PROJECT_PATH_LOOKUP_TIMEOUT_MS)
      : null;
    try {
      const response = await fetchFn(`${BACKEND_HTTP}/api/projects/${projectId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AGENT_TOKEN}`,
          Accept: "application/json",
        },
        signal: controller?.signal,
      });
      if (!response.ok) {
        return null;
      }
      const project = await response.json();
      const daemonHost =
        (typeof project.daemon_host === "string" && project.daemon_host.trim()) ||
        (typeof project.daemonHost === "string" && project.daemonHost.trim()) ||
        "";
      const workspacePath =
        (typeof project.workspace_path === "string" && project.workspace_path.trim()) ||
        (typeof project.workspacePath === "string" && project.workspacePath.trim()) ||
        "";
      if (workspacePath) {
        if (daemonHost && daemonHost !== AGENT_NAME) {
          return null;
        }
        return workspacePath;
      }
      if (!project.metadata) {
        return null;
      }
      const metadata = typeof project.metadata === "string" ? JSON.parse(project.metadata) : project.metadata;
      const localPaths = metadata.localPaths;
      if (!localPaths || typeof localPaths !== "object") {
        return null;
      }
      if (typeof localPaths[AGENT_NAME] === "string" && localPaths[AGENT_NAME].trim()) {
        return localPaths[AGENT_NAME];
      }
      if (typeof localPaths.default === "string" && localPaths.default.trim()) {
        return localPaths.default;
      }
      if (typeof localPaths["*"] === "string" && localPaths["*"].trim()) {
        return localPaths["*"];
      }
      return null;
    } catch (error) {
      if (error?.name === "AbortError") {
        log(
          `Project path lookup timed out after ${PROJECT_PATH_LOOKUP_TIMEOUT_MS}ms for ${projectId}`,
        );
      } else {
        log(`Failed to get project local path: ${error.message}`);
      }
      return null;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  let bridgeSessionHelperPromise = null;
  async function getBridgeSessionHelper() {
    if (typeof deps.bridgeSessionBetweenBackends === "function") {
      return deps.bridgeSessionBetweenBackends;
    }
    if (!bridgeSessionHelperPromise) {
      bridgeSessionHelperPromise = (async () => {
        try {
          const bridgeImportTarget =
            resolveImportTarget(process.env.CONDUCTOR_AI_BRIDGE_API_PATH) ||
            DEFAULT_AI_BRIDGE_API_SPECIFIER;
          const bridgeModule = await importOptionalModule(bridgeImportTarget);
          if (typeof bridgeModule.bridgeSessionBetweenBackends !== "function") {
            throw new Error("bridgeSessionBetweenBackends is not available");
          }
          return bridgeModule.bridgeSessionBetweenBackends;
        } catch (error) {
          bridgeSessionHelperPromise = null;
          throw error;
        }
      })();
    }
    return bridgeSessionHelperPromise;
  }

  function reportRestartFailure({ taskId, projectId, requestId, mode, error, sendAck = true, sendStatus = true }) {
    const prefix =
      mode === "bridge_to_new_task" || mode === "fork_to_new_task"
        ? "new task failed"
        : mode === "refresh_session_inplace"
          ? "session refresh failed"
        : "restart failed";
    const summary = `${prefix}: ${error?.message || error}`;
    if (mode === "refresh_session_inplace") {
      rememberCommandRequestAckResult(requestId, false);
    }
    if (sendAck) {
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "restart_task",
        accepted: false,
      }).catch(() => {});
    }
    if (!sendStatus) {
      return;
    }
    client
      .sendJson({
        type: "task_status_update",
        payload: {
          task_id: taskId,
          project_id: projectId,
          status: "KILLED",
          summary,
        },
      })
      .catch((err) => {
        logError(`Failed to report restart_task failure for ${taskId}: ${err?.message || err}`);
      });
  }

  function reportCreateTaskFailure({ taskId, projectId, requestId, error, sendAck = true }) {
    const normalizedTaskId = taskId ? String(taskId) : "";
    const normalizedProjectId = projectId ? String(projectId) : "";
    const message = error instanceof Error ? error.message : String(error);
    logError(`Failed to create task ${normalizedTaskId || "unknown"}: ${message}`);
    if (sendAck) {
      sendAgentCommandAck({
        requestId,
        taskId: normalizedTaskId,
        eventType: "create_task",
        accepted: false,
      }).catch((err) => {
        logError(`Failed to report agent_command_ack(create_task) for ${normalizedTaskId}: ${err?.message || err}`);
      });
    }
    if (!normalizedTaskId || !normalizedProjectId) {
      return;
    }
    client
      .sendJson({
        type: "task_status_update",
        payload: {
          task_id: normalizedTaskId,
          project_id: normalizedProjectId,
          status: "KILLED",
          summary: message,
        },
      })
      .catch((err) => {
        logError(`Failed to report task status (KILLED) for ${normalizedTaskId}: ${err?.message || err}`);
      });
  }

  async function resolveRestartCwd({
    taskId,
    projectId,
    preferredCwd = "",
    launchConfig = null,
    backendType,
    sessionId,
    sourceSessionFilePath = "",
  }) {
    const normalizedPreferredCwd = typeof preferredCwd === "string" ? preferredCwd.trim() : "";
    if (normalizedPreferredCwd) {
      return normalizedPreferredCwd;
    }

    const worktreeCwd = await ensureTaskWorktree({
      taskId,
      projectId,
      launchConfig,
    });
    if (worktreeCwd) {
      return worktreeCwd;
    }

    const configuredCwd = normalizeOptionalString(launchConfig?.cwd);
    if (configuredCwd) {
      return configuredCwd;
    }

    const boundPath = await getProjectLocalPath(projectId);
    if (boundPath) {
      return boundPath;
    }

    const normalizedBackend = normalizeRuntimeBackendName(backendType);
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (normalizedSessionId && normalizedBackend && normalizedBackend !== "opencode") {
      try {
        const configuredBackend = await resolveConfiguredRuntimeBackend(normalizedBackend, ALLOW_CLI_LIST, {
          configFilePath: config.CONFIG_FILE,
        });
        const resumeBackend = configuredBackend?.runtimeBackend ||
          await normalizeRuntimeBackendAlias(normalizedBackend, { configFilePath: config.CONFIG_FILE });
        const resumeContext = await (deps.resolveResumeContext || resolveResumeContext)(
          resumeBackend,
          normalizedSessionId,
          {
            cwd: process.cwd(),
            configFilePath: config.CONFIG_FILE,
          },
        );
        if (typeof resumeContext?.cwd === "string" && resumeContext.cwd.trim()) {
          return resumeContext.cwd.trim();
        }
      } catch {
        // ignore provider-specific fallback failure here; we'll try the remaining fallbacks
      }
    }

    const normalizedSessionPath =
      typeof sourceSessionFilePath === "string" ? sourceSessionFilePath.trim() : "";
    if (normalizedSessionPath) {
      try {
        const stats = fs.statSync(normalizedSessionPath);
        if (stats.isDirectory()) {
          return normalizedSessionPath;
        }
        return path.dirname(normalizedSessionPath);
      } catch {
        // ignore missing local path
      }
    }

    return "";
  }

  async function handleCreateTask(payload) {
    const {
      task_id: taskId,
      project_id: projectId,
      backend_type: backendType,
      initial_content: initialContent,
      request_id: requestIdRaw,
    } =
      payload || {};
    const launchConfig = normalizeLaunchConfig(payload?.launch_config);
    const requestId = requestIdRaw ? String(requestIdRaw) : "";

    if (!taskId || !projectId) {
      logError(`Invalid create_task payload: ${JSON.stringify(payload)}`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_task",
        accepted: false,
      }).catch(() => {});
      return;
    }

    if (requestId && !markRequestSeen(requestId)) {
      log(`Duplicate create_task ignored for ${taskId} (request_id=${requestId})`);
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_task",
        accepted: true,
      }).catch(() => {});
      return;
    }

    if (daemonShuttingDown) {
      rejectCreateTaskDuringShutdown(payload);
      return;
    }

    const existingTaskRecord = activeTaskProcesses.get(taskId);
    if (existingTaskRecord?.child || pendingTaskStarts.has(taskId)) {
      log(
        `Duplicate create_task ignored for ${taskId}: task already active (pid=${existingTaskRecord?.child?.pid ?? "unknown"})`,
      );
      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_task",
        accepted: true,
      }).catch(() => {});
      return;
    }

    pendingTaskStarts.add(taskId);
    let acceptedAckSent = false;
    try {
      const requestedBackend = normalizeRuntimeBackendName(backendType || SUPPORTED_BACKENDS[0]);
      const configuredBackend = await resolveConfiguredRuntimeBackend(requestedBackend, ALLOW_CLI_LIST, {
        configFilePath: config.CONFIG_FILE,
      });
      const effectiveBackend = configuredBackend?.runtimeBackend ||
        await normalizeRuntimeBackendAlias(requestedBackend, { configFilePath: config.CONFIG_FILE });
      const hasConfiguredEntry = Boolean(configuredBackend?.commandLine);
      const selectedBackend = configuredBackend?.commandLine
        ? configuredBackend.requestedBackend
        : effectiveBackend;
      const isAdvertisedBackend = SUPPORTED_BACKENDS.includes(selectedBackend);
      const isAllowedExternalBackend =
        !isBuiltInRuntimeBackend(effectiveBackend) &&
        await isRuntimeSupportedBackend(effectiveBackend, { configFilePath: config.CONFIG_FILE });
      if (!isAdvertisedBackend || (!hasConfiguredEntry && !isAllowedExternalBackend)) {
        logError(`Unsupported backend: ${selectedBackend}. Supported: ${SUPPORTED_BACKENDS.join(", ")}`);
        sendAgentCommandAck({
          requestId,
          taskId,
          eventType: "create_task",
          accepted: false,
        }).catch(() => {});
        client
          .sendJson({
            type: "task_status_update",
            payload: {
              task_id: taskId,
              project_id: projectId,
              status: "KILLED",
              summary: `Unsupported backend: ${selectedBackend}`,
            },
          })
          .catch(() => {});
        return;
      }

      sendAgentCommandAck({
        requestId,
        taskId,
        eventType: "create_task",
        accepted: true,
      }).catch((err) => {
        logError(`Failed to report agent_command_ack(create_task) for ${taskId}: ${err?.message || err}`);
      });
      acceptedAckSent = true;

      const cliCommand = ALLOW_CLI_LIST[selectedBackend] || ALLOW_CLI_LIST[effectiveBackend] || "";

      log("");
      log(`Creating task ${taskId} for project ${projectId} (${selectedBackend})`);
      log(`CLI command: ${formatBackendLaunchCommand(cliCommand)}`);
      client
        .sendJson({
          type: "task_status_update",
          payload: {
            task_id: taskId,
            project_id: projectId,
            status: "INIT",
          },
        })
        .catch((err) => {
          logError(`Failed to report task status (INIT) for ${taskId}: ${err?.message || err}`);
        });

      const boundPath = await getProjectLocalPath(projectId);
      if (daemonShuttingDown) {
        rejectCreateTaskDuringShutdown(payload, { sendAck: false });
        return;
      }

      let taskDir;
      let logPath;
      let runTimestampPart = null;

      const resolvedTaskWorkspace =
        (await ensureTaskWorktree({
          taskId,
          projectId,
          launchConfig,
        })) ||
        normalizeOptionalString(launchConfig.cwd) ||
        boundPath;

      if (resolvedTaskWorkspace) {
        taskDir = resolvedTaskWorkspace;
        log(`Using task workspace: ${taskDir}`);
        logPath = path.join(taskDir, "conductor.log");
      } else {
        const now = new Date();
        const dayDir = path.join(WORKSPACE_ROOT, formatWorkspaceDate(now));
        runTimestampPart = formatWorkspaceRunTimestamp(now);
        const pendingRunDir = `${runTimestampPart}_pid_${process.pid}`;
        taskDir = path.join(dayDir, pendingRunDir);
        mkdirSyncFn(taskDir, { recursive: true });
        logPath = path.join(taskDir, "conductor.log");
      }

      const args = [];
      if (selectedBackend) {
        args.push("--backend", selectedBackend);
      }
      if (initialContent) {
        args.push("--prefill", initialContent);
      }
      args.push("--");

      const env = {
        ...process.env,
        PWD: taskDir,
        CONDUCTOR_PROJECT_ID: projectId,
        CONDUCTOR_TASK_ID: taskId,
        CONDUCTOR_LAUNCHED_BY_DAEMON: "1",
        ...(cliCommand ? { CONDUCTOR_CLI_COMMAND: cliCommand } : {}),
      };
      if (config.CONFIG_FILE) {
        env.CONDUCTOR_CONFIG = config.CONFIG_FILE;
      }
      if (AGENT_TOKEN) {
        env.CONDUCTOR_AGENT_TOKEN = AGENT_TOKEN;
      }
      if (BACKEND_HTTP) {
        env.CONDUCTOR_BACKEND_URL = BACKEND_HTTP;
      }

      const child = spawnFn(process.execPath, [CLI_PATH_VAL, ...args], {
        cwd: taskDir,
        env,
        stdio: ["inherit", "pipe", "pipe"],
      });

      if (!boundPath && runTimestampPart && Number.isInteger(child?.pid) && child.pid > 0) {
        const desiredTaskDir = path.join(path.dirname(taskDir), `${runTimestampPart}_pid_${child.pid}`);
        if (desiredTaskDir !== taskDir) {
          try {
            renameSyncFn(taskDir, desiredTaskDir);
            taskDir = desiredTaskDir;
            logPath = path.join(taskDir, "conductor.log");
          } catch (err) {
            logError(
              `Failed to rename workspace dir from ${taskDir} to ${desiredTaskDir}: ${err?.message || err}`,
            );
          }
        }
      }

      try {
        mkdirSyncFn(taskDir, { recursive: true });
      } catch (err) {
        logError(`Failed to ensure task workspace ${taskDir}: ${err?.message || err}`);
      }

      let logStream;
      try {
        logStream = createWriteStreamFn(logPath, { flags: "a" });
        if (logStream && typeof logStream.on === "function") {
          const logPathSnapshot = logPath;
          logStream.on("error", (err) => {
            logError(`Log stream error (${logPathSnapshot}): ${err?.message || err}`);
          });
        }
      } catch (err) {
        logError(`Failed to open log file ${logPath}: ${err?.message || err}`);
      }

      log(`New task workspace: ${taskDir}`);
      log(`Logs: ${logPath}`);

      activeTaskProcesses.set(taskId, {
        child,
        projectId,
        logPath,
        stopForceKillTimer: null,
        managedByFireBridge: true,
      });

      client
        .sendJson({
          type: "task_status_update",
          payload: {
            task_id: taskId,
            project_id: projectId,
            status: "RUNNING",
          },
        })
        .catch((err) => {
          logError(`Failed to report task status (RUNNING) for ${taskId}: ${err?.message || err}`);
        });

      if (child.stdout && typeof child.stdout.pipe === "function" && logStream) {
        child.stdout.pipe(logStream, { end: false });
      } else if (child.stdout && typeof child.stdout.on === "function" && logStream) {
        child.stdout.on("data", (chunk) => logStream.write(chunk));
      }
      if (child.stderr && typeof child.stderr.pipe === "function" && logStream) {
        child.stderr.pipe(logStream, { end: false });
      } else if (child.stderr && typeof child.stderr.on === "function" && logStream) {
        child.stderr.on("data", (chunk) => logStream.write(chunk));
      }

      child.on("error", (err) => {
        logError(`Failed to spawn CLI: ${err.message}`);
        if (logStream) {
          const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
          logStream.write(`[daemon ${ts}] spawn error: ${err.message}\n`);
        }
      });

      child.on("exit", (code, signal) => {
        const active = activeTaskProcesses.get(taskId);
        if (active?.stopForceKillTimer) {
          clearTimeout(active.stopForceKillTimer);
        }
        activeTaskProcesses.delete(taskId);
        const suppressExitStatusReport = suppressedExitStatusReports.has(taskId);
        suppressedExitStatusReports.delete(taskId);
        if (logStream) {
          const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
          if (signal) {
            logStream.write(`[daemon ${ts}] process killed by signal ${signal}\n`);
          } else {
            logStream.write(`[daemon ${ts}] process exited with code ${code}\n`);
          }
          logStream.end();
        }
        if (signal) {
          log(`Task ${taskId} killed by signal ${signal}`);
        } else {
          log(`Task ${taskId} finished with code ${code}`);
        }
        log(`Logs: ${logPath}`);

        const isKilledBySignal = Boolean(signal);
        const isKilledByExitCode = code === 130 || code === 143;
        const isKilled = isKilledBySignal || isKilledByExitCode;

        const status = isKilled ? "KILLED" : code === 0 ? "COMPLETED" : "KILLED";
        const summary = isKilled
          ? (signal ? `killed by signal ${signal}` : `terminated (exit code ${code})`)
          : code === 0
            ? "completed"
            : `exited with code ${code}`;

        if (!suppressExitStatusReport && shouldDaemonReportFireChildTerminalStatus(active)) {
          client
            .sendJson({
              type: "task_status_update",
              payload: {
                task_id: taskId,
                project_id: projectId,
                status,
                summary,
              },
            })
            .catch((err) => {
              logError(`Failed to report task status (${status}) for ${taskId}: ${err?.message || err}`);
            });
        }
      });
    } catch (error) {
      reportCreateTaskFailure({
        taskId,
        projectId,
        requestId,
        error,
        sendAck: !acceptedAckSent,
      });
    } finally {
      pendingTaskStarts.delete(taskId);
    }
  }

  async function handleRestartTask(payload) {
    const {
      mode,
      source_task_id: sourceTaskId,
      target_task_id: targetTaskId,
      project_id: projectId,
      title,
      source_backend_type: sourceBackendType,
      source_session_id: sourceSessionId,
      source_session_file_path: sourceSessionFilePath,
      target_backend_type: targetBackendType,
      request_id: requestIdRaw,
    } = payload || {};

    const requestId = requestIdRaw ? String(requestIdRaw) : "";
    const normalizedMode = typeof mode === "string" ? mode.trim() : "";
    const normalizedSourceTaskId = sourceTaskId ? String(sourceTaskId) : "";
    const normalizedTargetTaskId = targetTaskId ? String(targetTaskId) : "";
    const normalizedProjectId = projectId ? String(projectId) : "";
    const normalizedSourceSessionId = sourceSessionId ? String(sourceSessionId).trim() : "";
    const targetLaunchConfig = normalizeLaunchConfig(payload?.target_launch_config);
    const isRefreshSessionInplace = normalizedMode === "refresh_session_inplace";
    const deferAcceptedAckUntilSpawn = isRefreshSessionInplace;

    if (
      !normalizedMode ||
      !normalizedSourceTaskId ||
      !normalizedTargetTaskId ||
      !normalizedProjectId ||
      !normalizedSourceSessionId
    ) {
      logError(`Invalid restart_task payload: ${JSON.stringify(payload)}`);
      sendAgentCommandAck({
        requestId,
        taskId: normalizedTargetTaskId || normalizedSourceTaskId,
        eventType: "restart_task",
        accepted: false,
      }).catch(() => {});
      return;
    }

    if (requestId && !markRequestSeen(requestId)) {
      log(
        `Duplicate restart_task ignored for ${normalizedTargetTaskId} (request_id=${requestId})`,
      );
      if (isRefreshSessionInplace && !completedCommandRequestAckResults.has(requestId)) {
        return;
      }
      sendAgentCommandAck({
        requestId,
        taskId: normalizedTargetTaskId,
        eventType: "restart_task",
        accepted: completedCommandRequestAckResults.get(requestId) ?? true,
      }).catch(() => {});
      return;
    }

    if (daemonShuttingDown) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error: new Error("daemon shutting down"),
        sendStatus: !isRefreshSessionInplace,
      });
      return;
    }

    if (isRefreshSessionInplace) {
      if (refreshSessionRestartTaskIds.has(normalizedTargetTaskId)) {
        reportRestartFailure({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          requestId,
          mode: normalizedMode,
          error: new Error("session refresh already in progress"),
          sendStatus: false,
        });
        return;
      }
      refreshSessionRestartTaskIds.add(normalizedTargetTaskId);
    }

    let acceptedRestartAckSent = false;
    let refreshStoppedActiveTask = false;
    let startupTerminalStatusReported = false;
    try {
    const activeTarget = activeTaskProcesses.get(normalizedTargetTaskId);
    if (isRefreshSessionInplace) {
      if (!activeTarget?.child) {
        reportRestartFailure({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          requestId,
          mode: normalizedMode,
          error: new Error("task is not active on this daemon"),
          sendStatus: false,
        });
        return;
      }
    } else if (activeTarget?.child) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error: new Error(`task already active (pid=${activeTarget.child.pid ?? "unknown"})`),
      });
      return;
    }

    const requestedBackend = normalizeRuntimeBackendName(targetBackendType || sourceBackendType || SUPPORTED_BACKENDS[0]);
    const configuredBackend = await resolveConfiguredRuntimeBackend(requestedBackend, ALLOW_CLI_LIST, {
      configFilePath: config.CONFIG_FILE,
    });
    const effectiveBackend = configuredBackend?.runtimeBackend ||
      await normalizeRuntimeBackendAlias(requestedBackend, { configFilePath: config.CONFIG_FILE });
    const hasConfiguredEntry = Boolean(configuredBackend?.commandLine);
    const selectedBackend = configuredBackend?.commandLine
      ? configuredBackend.requestedBackend
      : effectiveBackend;
    const isAdvertisedBackend = SUPPORTED_BACKENDS.includes(selectedBackend);
    const isAllowedExternalBackend =
      !isBuiltInRuntimeBackend(effectiveBackend) &&
      await isRuntimeSupportedBackend(effectiveBackend, { configFilePath: config.CONFIG_FILE });
    if (!isAdvertisedBackend || (!hasConfiguredEntry && !isAllowedExternalBackend)) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error: new Error(`Unsupported backend: ${selectedBackend}`),
        sendStatus: !isRefreshSessionInplace,
      });
      return;
    }

    if (normalizedMode === "resume_inplace" || normalizedMode === "refresh_session_inplace") {
      if (normalizedTargetTaskId !== normalizedSourceTaskId) {
        reportRestartFailure({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          requestId,
          mode: normalizedMode,
          error: new Error("In-place restart must reuse the same task"),
          sendStatus: !isRefreshSessionInplace,
        });
        return;
      }
      const normalizedSourceBackend = normalizeRuntimeBackendName(sourceBackendType);
      const configuredSourceBackend = await resolveConfiguredRuntimeBackend(normalizedSourceBackend, ALLOW_CLI_LIST, {
        configFilePath: config.CONFIG_FILE,
      });
      const sourceRuntimeBackend = configuredSourceBackend?.runtimeBackend ||
        await normalizeRuntimeBackendAlias(normalizedSourceBackend, { configFilePath: config.CONFIG_FILE });
      const sourceSelectedBackend = configuredSourceBackend?.commandLine
        ? configuredSourceBackend.requestedBackend
        : sourceRuntimeBackend;
      if (selectedBackend !== sourceSelectedBackend) {
        reportRestartFailure({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          requestId,
          mode: normalizedMode,
          error: new Error("In-place restart must reuse the same backend"),
          sendStatus: !isRefreshSessionInplace,
        });
        return;
      }
    }

    if (!deferAcceptedAckUntilSpawn) {
      acceptedRestartAckSent = true;
      sendAgentCommandAck({
        requestId,
        taskId: normalizedTargetTaskId,
        eventType: "restart_task",
        accepted: true,
      }).catch((err) => {
        logError(`Failed to report agent_command_ack(restart_task) for ${normalizedTargetTaskId}: ${err?.message || err}`);
      });
    }

    const normalizedSourceBackend = normalizeRuntimeBackendName(sourceBackendType);
    const configuredSourceBackend = await resolveConfiguredRuntimeBackend(normalizedSourceBackend, ALLOW_CLI_LIST, {
      configFilePath: config.CONFIG_FILE,
    });
    const sourceRuntimeBackend = configuredSourceBackend?.runtimeBackend ||
      await normalizeRuntimeBackendAlias(normalizedSourceBackend, { configFilePath: config.CONFIG_FILE });

    let resolvedResumeSessionId = normalizedSourceSessionId;
    let resolvedResumeCwd = "";
    try {
      if (normalizedMode === "bridge_to_new_task" || normalizedMode === "fork_to_new_task") {
        const sourceResumeCwd = await resolveRestartCwd({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          backendType: sourceBackendType,
          launchConfig: targetLaunchConfig,
          sessionId: normalizedSourceSessionId,
          sourceSessionFilePath: sourceSessionFilePath ? String(sourceSessionFilePath) : "",
        });
        const bridgeSession = await getBridgeSessionHelper();
        const bridgeResult = await bridgeSession({
          sourceTool: sourceRuntimeBackend,
          sourceSessionId: normalizedSourceSessionId,
          sourceSessionPath: sourceSessionFilePath ? String(sourceSessionFilePath) : undefined,
          sourceSessionInfo: {
            tool: sourceRuntimeBackend,
            sessionId: normalizedSourceSessionId,
            path: sourceSessionFilePath ? String(sourceSessionFilePath) : undefined,
            cwd: sourceResumeCwd || undefined,
          },
          targetTool: effectiveBackend,
          targetCwdFallback: sourceResumeCwd || undefined,
        });
        resolvedResumeSessionId = bridgeResult.sessionId;
        resolvedResumeCwd = await resolveRestartCwd({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          preferredCwd: bridgeResult.cwd,
          launchConfig: targetLaunchConfig,
          backendType: effectiveBackend,
          sessionId: bridgeResult.sessionId,
          sourceSessionFilePath: sourceSessionFilePath ? String(sourceSessionFilePath) : "",
        });
      } else if (
        normalizedMode === "resume_inplace" ||
        normalizedMode === "refresh_session_inplace"
      ) {
        resolvedResumeCwd = await resolveRestartCwd({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          launchConfig: targetLaunchConfig,
          backendType: effectiveBackend,
          sessionId: normalizedSourceSessionId,
          sourceSessionFilePath: sourceSessionFilePath ? String(sourceSessionFilePath) : "",
        });
      } else {
        throw new Error(`Unsupported restart mode: ${normalizedMode}`);
      }
    } catch (error) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error,
        sendAck: deferAcceptedAckUntilSpawn,
        sendStatus: !isRefreshSessionInplace,
      });
      return;
    }

    if (!resolvedResumeCwd) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error: new Error("Could not resolve resume cwd"),
        sendAck: deferAcceptedAckUntilSpawn,
        sendStatus: !isRefreshSessionInplace,
      });
      return;
    }

    const cliCommand = ALLOW_CLI_LIST[selectedBackend] || ALLOW_CLI_LIST[effectiveBackend] || "";

    log("");
    log(
      `Restarting task ${normalizedTargetTaskId} from ${normalizedSourceTaskId} (${normalizedMode} -> ${selectedBackend})`,
    );
    log(`CLI command: ${formatBackendLaunchCommand(cliCommand)}`);

    if (
      normalizedMode !== "resume_inplace" &&
      normalizedMode !== "refresh_session_inplace"
    ) {
      client
        .sendJson({
          type: "task_status_update",
          payload: {
            task_id: normalizedTargetTaskId,
            project_id: normalizedProjectId,
            status: "INIT",
          },
        })
        .catch((err) => {
          logError(`Failed to report task status (INIT) for ${normalizedTargetTaskId}: ${err?.message || err}`);
        });
    }

    if (daemonShuttingDown) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error: new Error("daemon shutting down"),
        sendAck: deferAcceptedAckUntilSpawn,
        sendStatus: !isRefreshSessionInplace,
      });
      return;
    }

    if (isRefreshSessionInplace) {
      const stopStarted = stopActiveTaskProcess(normalizedTargetTaskId, {
        reason: "refresh_session_inplace",
        suppressExitStatusReport: true,
      });
      if (!stopStarted) {
        reportRestartFailure({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          requestId,
          mode: normalizedMode,
          error: new Error("task is not active on this daemon"),
          sendAck: true,
          sendStatus: false,
        });
        return;
      }
      const stopped = await waitForTaskToStop(normalizedTargetTaskId);
      refreshStoppedActiveTask = true;
      if (
        !stopped &&
        (activeTaskProcesses.has(normalizedTargetTaskId) || activePtySessions.has(normalizedTargetTaskId))
      ) {
        const activeRefreshTarget =
          activeTaskProcesses.get(normalizedTargetTaskId) ||
          activePtySessions.get(normalizedTargetTaskId) ||
          null;
        if (activeRefreshTarget && typeof activeRefreshTarget === "object") {
          activeRefreshTarget.forceDaemonTerminalStatusReport = true;
        }
        suppressedExitStatusReports.delete(normalizedTargetTaskId);
        reportRestartFailure({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          requestId,
          mode: normalizedMode,
          error: new Error("Timed out waiting for the active task to stop"),
          sendAck: true,
          sendStatus: false,
        });
        return;
      }
    }

    if (daemonShuttingDown) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error: new Error("daemon shutting down"),
        sendAck: deferAcceptedAckUntilSpawn,
        sendStatus: !isRefreshSessionInplace || refreshStoppedActiveTask,
      });
      return;
    }

    let taskDir = resolvedResumeCwd;
    let logPath = path.join(taskDir, "conductor.log");

    try {
      mkdirSyncFn(taskDir, { recursive: true });
    } catch (err) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error: new Error(`Failed to ensure task workspace ${taskDir}: ${err?.message || err}`),
        sendAck: deferAcceptedAckUntilSpawn,
      });
      return;
    }

    const shouldResumeSession = true;
    const args = [];
    if (selectedBackend) {
      args.push("--backend", selectedBackend);
    }
    if (shouldResumeSession) {
      args.push("--resume", resolvedResumeSessionId);
    }
    args.push("--");

    const env = {
      ...process.env,
      PWD: taskDir,
      CONDUCTOR_PROJECT_ID: normalizedProjectId,
      CONDUCTOR_TASK_ID: normalizedTargetTaskId,
      CONDUCTOR_LAUNCHED_BY_DAEMON: "1",
      ...(cliCommand ? { CONDUCTOR_CLI_COMMAND: cliCommand } : {}),
    };
    env.CONDUCTOR_RESUME_CWD = resolvedResumeCwd;
    if (config.CONFIG_FILE) {
      env.CONDUCTOR_CONFIG = config.CONFIG_FILE;
    }
    if (AGENT_TOKEN) {
      env.CONDUCTOR_AGENT_TOKEN = AGENT_TOKEN;
    }
    if (BACKEND_HTTP) {
      env.CONDUCTOR_BACKEND_URL = BACKEND_HTTP;
    }

    const child = spawnFn(process.execPath, [CLI_PATH_VAL, ...args], {
      cwd: taskDir,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let logStream;
    try {
      logStream = createWriteStreamFn(logPath, { flags: "a" });
      if (logStream && typeof logStream.on === "function") {
        const logPathSnapshot = logPath;
        logStream.on("error", (err) => {
          logError(`Log stream error (${logPathSnapshot}): ${err?.message || err}`);
        });
      }
    } catch (err) {
      logError(`Failed to open log file ${logPath}: ${err?.message || err}`);
    }

    log(`Task title: ${title || normalizedTargetTaskId}`);
    if (normalizedMode === "refresh_session_inplace") {
      log(`Refreshing source session: ${normalizedSourceSessionId}`);
    }
    log(`Resume session: ${resolvedResumeSessionId}`);
    log(`Resume cwd: ${resolvedResumeCwd}`);
    log(`Logs: ${logPath}`);

    const activeProcessRecord = {
      child,
      projectId: normalizedProjectId,
      logPath,
      stopForceKillTimer: null,
      managedByFireBridge: true,
    };
    activeTaskProcesses.set(normalizedTargetTaskId, activeProcessRecord);

    if (child.stdout && typeof child.stdout.pipe === "function" && logStream) {
      child.stdout.pipe(logStream, { end: false });
    } else if (child.stdout && typeof child.stdout.on === "function" && logStream) {
      child.stdout.on("data", (chunk) => logStream.write(chunk));
    }
    if (child.stderr && typeof child.stderr.pipe === "function" && logStream) {
      child.stderr.pipe(logStream, { end: false });
    } else if (child.stderr && typeof child.stderr.on === "function" && logStream) {
      child.stderr.on("data", (chunk) => logStream.write(chunk));
    }

    child.on("error", (err) => {
      logError(`Failed to spawn restart CLI for ${normalizedTargetTaskId}: ${err.message}`);
      if (logStream) {
        const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
        logStream.write(`[daemon ${ts}] spawn error: ${err.message}\n`);
      }
    });

    child.on("exit", (code, signal) => {
      const active = activeTaskProcesses.get(normalizedTargetTaskId);
      if (active?.stopForceKillTimer) {
        clearTimeout(active.stopForceKillTimer);
      }
      activeTaskProcesses.delete(normalizedTargetTaskId);
      const suppressExitStatusReport = suppressedExitStatusReports.has(normalizedTargetTaskId);
      suppressedExitStatusReports.delete(normalizedTargetTaskId);
      if (logStream) {
        const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
        if (signal) {
          logStream.write(`[daemon ${ts}] process killed by signal ${signal}\n`);
        } else {
          logStream.write(`[daemon ${ts}] process exited with code ${code}\n`);
        }
        logStream.end();
      }

      const isKilledBySignal = Boolean(signal);
      const isKilledByExitCode = code === 130 || code === 143;
      const isKilled = isKilledBySignal || isKilledByExitCode;
      const status = isKilled ? "KILLED" : code === 0 ? "COMPLETED" : "KILLED";
      const summary = isKilled
        ? (signal ? `killed by signal ${signal}` : `terminated (exit code ${code})`)
        : code === 0
          ? "completed"
          : `exited with code ${code}`;

      const shouldReportTerminalStatus =
        !suppressExitStatusReport &&
        (!acceptedRestartAckSent || shouldDaemonReportFireChildTerminalStatus(active));
      if (shouldReportTerminalStatus) {
        if (!acceptedRestartAckSent) {
          startupTerminalStatusReported = true;
        }
        client
          .sendJson({
            type: "task_status_update",
            payload: {
              task_id: normalizedTargetTaskId,
              project_id: normalizedProjectId,
              status,
              summary,
            },
          })
          .catch((err) => {
            logError(`Failed to report task status (${status}) for ${normalizedTargetTaskId}: ${err?.message || err}`);
        });
      }
    });

    await client
      .sendJson({
        type: "task_status_update",
        payload: {
          task_id: normalizedTargetTaskId,
          project_id: normalizedProjectId,
          status: "RUNNING",
        },
      })
      .catch((err) => {
        logError(`Failed to report task status (RUNNING) for ${normalizedTargetTaskId}: ${err?.message || err}`);
      });

    if (deferAcceptedAckUntilSpawn) {
      const currentActive = activeTaskProcesses.get(normalizedTargetTaskId);
      if (!currentActive || currentActive.child !== child) {
        reportRestartFailure({
          taskId: normalizedTargetTaskId,
          projectId: normalizedProjectId,
          requestId,
          mode: normalizedMode,
          error: new Error("replacement session exited before startup completed"),
          sendAck: true,
          sendStatus: !startupTerminalStatusReported,
        });
        return;
      }

      rememberCommandRequestAckResult(requestId, true);
      acceptedRestartAckSent = true;
      await sendAgentCommandAck({
        requestId,
        taskId: normalizedTargetTaskId,
        eventType: "restart_task",
        accepted: true,
      }).catch((err) => {
        logError(`Failed to report agent_command_ack(restart_task) for ${normalizedTargetTaskId}: ${err?.message || err}`);
      });
    }
    } catch (error) {
      reportRestartFailure({
        taskId: normalizedTargetTaskId,
        projectId: normalizedProjectId,
        requestId,
        mode: normalizedMode,
        error,
        sendAck: !acceptedRestartAckSent,
        sendStatus: !isRefreshSessionInplace || refreshStoppedActiveTask,
      });
    } finally {
      if (isRefreshSessionInplace) {
        refreshSessionRestartTaskIds.delete(normalizedTargetTaskId);
      }
    }
  }

  let closePromise = null;
  async function shutdownDaemon(reason = "manual close") {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      daemonShuttingDown = true;
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      const activeProcessEntries = [...activeTaskProcesses.entries()];
      const activePtyEntries = [...activePtySessions.entries()];
      const activeEntries = [...activeProcessEntries, ...activePtyEntries];
      if (activeEntries.length > 0) {
        log(`Shutdown requested (${reason}); stopping ${activeEntries.length} active task(s)`);
      }

      await Promise.allSettled(
        activeEntries.map(async ([taskId, record]) => {
          suppressedExitStatusReports.add(taskId);
          if (!shouldDaemonReportFireChildTerminalStatus(record)) {
            return;
          }
          try {
            await withTimeout(
              client.sendJson({
                type: "task_status_update",
                payload: {
                  task_id: taskId,
                  project_id: record.projectId,
                  status: "KILLED",
                  summary: `daemon shutdown (${reason})`,
                },
              }),
              SHUTDOWN_STATUS_REPORT_TIMEOUT_MS,
              `report shutdown status for ${taskId}`,
            );
          } catch (err) {
            logError(`Failed to report shutdown status (KILLED) for ${taskId}: ${err?.message || err}`);
          }
        }),
      );

      for (const [taskId, record] of activeProcessEntries) {
        if (record?.stopForceKillTimer) {
          clearTimeout(record.stopForceKillTimer);
        }
        try {
          if (typeof record.child?.kill === "function") {
            record.child.kill("SIGTERM");
          }
        } catch (error) {
          logError(`Failed to stop task ${taskId} on daemon close: ${error?.message || error}`);
        }
      }

      for (const [taskId, record] of activePtyEntries) {
        if (record?.stopForceKillTimer) {
          clearTimeout(record.stopForceKillTimer);
        }
        cleanupPtyRtcTransport(taskId);
        try {
          if (typeof record.pty?.kill === "function") {
            record.pty.kill("SIGTERM");
          }
        } catch (error) {
          logError(`Failed to stop PTY task ${taskId} on daemon close: ${error?.message || error}`);
        }
      }

      activeTaskProcesses.clear();
      activePtySessions.clear();

      try {
        await withTimeout(
          Promise.resolve(client.disconnect()),
          SHUTDOWN_DISCONNECT_TIMEOUT_MS,
          "disconnect daemon websocket",
        );
      } catch (error) {
        logError(`Failed to disconnect client on daemon close: ${error?.message || error}`);
      }
    })();

    return closePromise;
  }

  requestShutdown = shutdownDaemon;

  return {
    close: () => {
      detachProcessHandlers();
      return shutdownDaemon();
    },
  };
}

async function cleanAllAgents(backendUrl, agentToken, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const target = `${backendUrl.replace(/\/$/, "")}/agents/cleanup`;
  const headers = {
    Authorization: `Bearer ${agentToken}`,
  };
  const res = await fetchFn(target, { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`cleanup failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function deriveBackendHttpFromWebsocket(wsUrl) {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function deriveWebsocketUrlFromHttp(httpUrl) {
  try {
    const url = new URL(httpUrl);
    const scheme = url.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${url.host}/ws/agent`;
  } catch {
    return "ws://localhost:6152/ws/agent";
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function parseBooleanEnv(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveRtcModuleCandidates(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [...DEFAULT_RTC_MODULE_CANDIDATES];
  }
  const candidates = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return candidates.length > 0 ? [...new Set(candidates)] : [...DEFAULT_RTC_MODULE_CANDIDATES];
}

function formatDisconnectDiagnostics(event) {
  const parts = [];
  const reason = typeof event?.reason === "string" && event.reason.trim()
    ? event.reason.trim()
    : "unknown";
  parts.push(`reason=${reason}`);
  if (Number.isFinite(event?.closeCode)) {
    parts.push(`close_code=${event.closeCode}`);
  }
  if (typeof event?.closeReason === "string" && event.closeReason.trim()) {
    parts.push(`close_reason=${event.closeReason.trim()}`);
  }
  if (typeof event?.socketError === "string" && event.socketError.trim()) {
    parts.push(`socket_error=${event.socketError.trim()}`);
  }
  if (Number.isFinite(event?.missedPongs) && event.missedPongs > 0) {
    parts.push(`missed_pongs=${event.missedPongs}`);
  }
  if (Number.isFinite(event?.lastPingAt)) {
    parts.push(`last_ping_at=${formatIsoTimestamp(event.lastPingAt)}`);
  }
  if (Number.isFinite(event?.lastPongAt)) {
    parts.push(`last_pong_at=${formatIsoTimestamp(event.lastPongAt)}`);
  }
  if (Number.isFinite(event?.lastMessageAt)) {
    parts.push(`last_message_at=${formatIsoTimestamp(event.lastMessageAt)}`);
  }
  return parts.join(" ");
}

function formatDaemonHealthState({
  connectedAt,
  lastPongAt,
  lastInboundAt,
  lastSuccessfulHttpAt,
  lastPresenceConfirmedAt,
}) {
  return [
    `connected_at=${formatIsoTimestamp(connectedAt)}`,
    `last_pong_at=${formatIsoTimestamp(lastPongAt)}`,
    `last_inbound_at=${formatIsoTimestamp(lastInboundAt)}`,
    `last_http_ok_at=${formatIsoTimestamp(lastSuccessfulHttpAt)}`,
    `last_presence_at=${formatIsoTimestamp(lastPresenceConfirmedAt)}`,
  ].join(" ");
}

function formatWatchdogExtra(extra) {
  const parts = [];
  if (Number.isFinite(extra?.agentCount)) {
    parts.push(`agent_count=${extra.agentCount}`);
  }
  if (Number.isFinite(extra?.probeStatus)) {
    parts.push(`probe_status=${extra.probeStatus}`);
  }
  if (Number.isFinite(extra?.probeAt)) {
    parts.push(`probe_at=${formatIsoTimestamp(extra.probeAt)}`);
  }
  if (typeof extra?.probeError === "string" && extra.probeError.trim()) {
    parts.push(`probe_error=${extra.probeError.trim()}`);
  }
  if (Number.isFinite(extra?.lastWsHealthAt)) {
    parts.push(`last_ws_health_at=${formatIsoTimestamp(extra.lastWsHealthAt)}`);
  }
  if (Number.isFinite(extra?.staleForMs)) {
    parts.push(`stale_for_ms=${extra.staleForMs}`);
  }
  return parts.length ? parts.join(" ") : "no-extra-diagnostics";
}

function formatIsoTimestamp(value) {
  if (!Number.isFinite(value)) {
    return "never";
  }
  return new Date(value).toISOString();
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer?.unref === "function") {
      timer.unref();
    }
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function expandHomePath(inputPath, homeDir) {
  if (typeof inputPath !== "string" || !inputPath) {
    return inputPath;
  }
  if (inputPath === "~") {
    return homeDir;
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

function formatWorkspaceDate(date) {
  const [datePart] = formatBeijingDateTimeParts(date);
  return datePart;
}

function formatWorkspaceRunTimestamp(date) {
  const [, timePart] = formatBeijingDateTimeParts(date);
  return timePart.replace(/:/g, "-");
}

function formatBeijingDateTimeParts(date) {
  const formatted = date.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
  const [datePart = "1970-01-01", timePart = "00:00:00"] = formatted.split(" ");
  return [datePart, timePart];
}
