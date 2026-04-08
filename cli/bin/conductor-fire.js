#!/usr/bin/env node

/**
 * conductor-fire - Conductor-aware AI coding agent runner.
 *
 * Supports configurable backends via allow_cli_list in config file.
 * This CLI bridges various AI coding agents with Conductor via the Conductor SDK.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import yaml from "js-yaml";
import { createAiSession } from "@love-moon/ai-sdk";
import { ConductorClient, ProjectContext, loadConfig } from "@love-moon/conductor-sdk";
import {
  buildResumeArgsForBackend as buildCliResumeArgsForBackend,
  resolveResumeContext as resolveCliResumeContext,
  resolveSessionRunDirectory as resolveCliSessionRunDirectory,
  resumeProviderForBackend as resumeProviderForCliBackend,
} from "../src/fire/resume.js";
import {
  filterRuntimeSupportedAllowCliList,
  RUNTIME_SUPPORTED_BACKENDS,
  listRuntimeSupportedBackends,
  normalizeRuntimeBackendAlias,
  normalizeRuntimeBackendName,
} from "../src/runtime-backends.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.join(__dirname, "..");
const INITIAL_CLI_PROJECT_PATH = process.cwd();
const FIRE_LOG_PATH = path.join(INITIAL_CLI_PROJECT_PATH, "conductor.log");
const FIRE_TASK_MARKER_PREFIX = "active-fire";

export function isLaunchedByDaemon(env = process.env) {
  const daemonHostedValue =
    typeof env?.CONDUCTOR_LAUNCHED_BY_DAEMON === "string" ? env.CONDUCTOR_LAUNCHED_BY_DAEMON.trim().toLowerCase() : "";
  if (daemonHostedValue && daemonHostedValue !== "0" && daemonHostedValue !== "false" && daemonHostedValue !== "no") {
    return true;
  }
  return Boolean(
    typeof env?.CONDUCTOR_CLI_COMMAND === "string" && env.CONDUCTOR_CLI_COMMAND.trim(),
  );
}

const ENABLE_FIRE_LOCAL_LOG = !isLaunchedByDaemon(process.env);

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));
const CLI_NAME = (process.env.CONDUCTOR_CLI_NAME || path.basename(process.argv[1] || "conductor-fire")).replace(
  /\.js$/,
  "",
);

export function buildConductorConnectHeaders(version = pkgJson.version) {
  return {
    "x-conductor-version": version,
  };
}

export function shouldRunReconnectRecovery({
  isReconnect,
  fireShuttingDown = false,
  runner = null,
} = {}) {
  if (!isReconnect || fireShuttingDown) {
    return false;
  }
  if (!runner || typeof runner.shouldSuppressReconnectRecovery !== "function") {
    return true;
  }
  return !runner.shouldSuppressReconnectRecovery();
}

// Load allow_cli_list from config file (no defaults - must be configured)
async function loadAllowCliList(configFilePath) {
  const home = os.homedir();
  const configPath = configFilePath || process.env.CONDUCTOR_CONFIG || path.join(home, ".conductor", "config.yaml");
  let parsed = null;
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8");
      parsed = yaml.load(content);
    }
  } catch (error) {
    // ignore error
  }
  if (parsed && typeof parsed === "object" && parsed.allow_cli_list) {
    return await filterRuntimeSupportedAllowCliList(parsed.allow_cli_list, { configFilePath: configPath });
  }
  return {};
}

export function resolveAiSessionCommandLine(backend, allowCliList, env = process.env) {
  const normalizedBackend = normalizeRuntimeBackendName(backend);
  const envKeyByBackend = {
    opencode: "CONDUCTOR_OPENCODE_COMMAND",
    kimi: "CONDUCTOR_KIMI_COMMAND",
  };
  const envKey = envKeyByBackend[normalizedBackend];
  if (!envKey) {
    return "";
  }

  const preferredEnvCommand = typeof env?.[envKey] === "string" ? env[envKey].trim() : "";
  if (preferredEnvCommand) {
    return preferredEnvCommand;
  }

  const configuredCommand =
    allowCliList && typeof allowCliList === "object" && typeof allowCliList[normalizedBackend] === "string"
      ? allowCliList[normalizedBackend].trim()
      : "";
  if (configuredCommand) {
    return configuredCommand;
  }

  const daemonCommand =
    typeof env?.CONDUCTOR_CLI_COMMAND === "string" ? env.CONDUCTOR_CLI_COMMAND.trim() : "";
  if (daemonCommand) {
    return daemonCommand;
  }

  return "";
}

const DEFAULT_POLL_INTERVAL_MS = parseInt(
  process.env.CONDUCTOR_CLI_POLL_INTERVAL_MS || process.env.CCODEX_POLL_INTERVAL_MS || "2000",
  10,
);
const DEFAULT_ERROR_LOOP_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_ERROR_LOOP_BACKOFF_MS = 3 * 60 * 1000;
const DEFAULT_ERROR_LOOP_THRESHOLD = 3;
const SESSION_BOOTSTRAP_LOCK_TIMEOUT_MS = 15_000;
const SESSION_BOOTSTRAP_LOCK_RETRY_MS = 50;
const FIRE_WATCHDOG_INTERVAL_MS = getBoundedEnvInt(
  "CONDUCTOR_FIRE_WATCHDOG_INTERVAL_MS",
  10_000,
  1_000,
  60_000,
);
const FIRE_WATCHDOG_STALE_WS_MS = getBoundedEnvInt(
  "CONDUCTOR_FIRE_WATCHDOG_STALE_WS_MS",
  45_000,
  5_000,
  5 * 60_000,
);
const FIRE_WATCHDOG_CONNECT_GRACE_MS = getBoundedEnvInt(
  "CONDUCTOR_FIRE_WATCHDOG_CONNECT_GRACE_MS",
  15_000,
  1_000,
  60_000,
);
const FIRE_WATCHDOG_RECONNECT_COOLDOWN_MS = getBoundedEnvInt(
  "CONDUCTOR_FIRE_WATCHDOG_RECONNECT_COOLDOWN_MS",
  15_000,
  1_000,
  2 * 60_000,
);

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  try {
    const buffer = new SharedArrayBuffer(4);
    const arr = new Int32Array(buffer);
    Atomics.wait(arr, 0, 0, ms);
  } catch {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ms) {
      // busy wait fallback
    }
  }
}

function resolveLockWorkingDirectory(workingDirectory) {
  const normalizedPath =
    typeof workingDirectory === "string" && workingDirectory.trim()
      ? path.resolve(workingDirectory.trim())
      : process.cwd();
  try {
    return fs.realpathSync(normalizedPath);
  } catch {
    return normalizedPath;
  }
}

export function resolveFreshSessionBootstrapLockPath(backendName, workingDirectory) {
  const normalizedBackend = String(backendName || "").trim().toLowerCase();
  if (normalizedBackend !== "codex") {
    return null;
  }
  const lockKey = `${normalizedBackend}:${resolveLockWorkingDirectory(workingDirectory)}`;
  const digest = createHash("sha1").update(lockKey).digest("hex");
  return path.join(os.homedir(), ".conductor", "locks", `session-bootstrap-${digest}.lock`);
}

function acquireFileLock(lockPath) {
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      return () => {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close failure
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore unlink failure
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt > SESSION_BOOTSTRAP_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for fresh session lock: ${lockPath}`);
      }
      sleepSync(SESSION_BOOTSTRAP_LOCK_RETRY_MS);
    }
  }
}

export async function withFreshSessionBootstrapLock(backendName, workingDirectory, fn) {
  const lockPath = resolveFreshSessionBootstrapLockPath(backendName, workingDirectory);
  if (!lockPath) {
    return await fn();
  }
  const release = acquireFileLock(lockPath);
  try {
    return await fn();
  } finally {
    release();
  }
}

function appendFireLocalLog(line) {
  if (!ENABLE_FIRE_LOCAL_LOG) {
    return;
  }
  try {
    fs.appendFileSync(FIRE_LOG_PATH, line);
  } catch {
    // ignore file log errors
  }
}

function formatFireDisconnectDiagnostics(event = {}) {
  const parts = [];
  if (event.reason) {
    parts.push(`reason=${event.reason}`);
  }
  if (typeof event.closeCode === "number") {
    parts.push(`close_code=${event.closeCode}`);
  }
  if (event.closeReason) {
    parts.push(`close_reason=${sanitizeForLog(event.closeReason, 120)}`);
  }
  if (event.socketError) {
    parts.push(`socket_error=${sanitizeForLog(event.socketError, 120)}`);
  }
  if (typeof event.missedPongs === "number" && event.missedPongs > 0) {
    parts.push(`missed_pongs=${event.missedPongs}`);
  }
  return parts.join(" ") || "reason=connection_lost";
}

function formatIsoTimestamp(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  return new Date(value).toISOString();
}

function formatFireWatchdogState({ connectedAt, lastPongAt, lastInboundAt }) {
  return [
    `connected_at=${formatIsoTimestamp(connectedAt)}`,
    `last_pong_at=${formatIsoTimestamp(lastPongAt)}`,
    `last_inbound_at=${formatIsoTimestamp(lastInboundAt)}`,
  ].join(" ");
}

export class FireWatchdog {
  constructor({
    intervalMs = FIRE_WATCHDOG_INTERVAL_MS,
    staleWsMs = FIRE_WATCHDOG_STALE_WS_MS,
    connectGraceMs = FIRE_WATCHDOG_CONNECT_GRACE_MS,
    reconnectCooldownMs = FIRE_WATCHDOG_RECONNECT_COOLDOWN_MS,
    onForceReconnect,
    logger = () => {},
    now = () => Date.now(),
  } = {}) {
    this.intervalMs = intervalMs;
    this.staleWsMs = staleWsMs;
    this.connectGraceMs = connectGraceMs;
    this.reconnectCooldownMs = reconnectCooldownMs;
    this.onForceReconnect = onForceReconnect;
    this.logger = logger;
    this.now = now;
    this.wsConnected = false;
    this.lastConnectedAt = null;
    this.lastPongAt = null;
    this.lastInboundAt = null;
    this.lastHealAt = 0;
    this.healAttempts = 0;
    this.awaitingHealthySignalAt = null;
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  onConnected({ isReconnect = false, connectedAt = this.now() } = {}) {
    this.wsConnected = true;
    this.lastConnectedAt = connectedAt;
    this.lastPongAt =
      Number.isFinite(this.lastPongAt) && this.lastPongAt > connectedAt ? this.lastPongAt : connectedAt;
    if (isReconnect && this.healAttempts > 0) {
      this.awaitingHealthySignalAt = connectedAt;
    } else if (!isReconnect) {
      this.awaitingHealthySignalAt = null;
    }
  }

  onDisconnected() {
    this.wsConnected = false;
  }

  onPong({ at = this.now() } = {}) {
    this.lastPongAt = at;
    this.markHealthy("pong", at);
  }

  onInbound(at = this.now()) {
    this.lastInboundAt = at;
    this.markHealthy("inbound", at);
  }

  markHealthy(signal, at = this.now()) {
    if (!this.awaitingHealthySignalAt || this.healAttempts === 0) {
      return;
    }
    if (at < this.awaitingHealthySignalAt) {
      return;
    }
    this.logger(
      `[watchdog] Backend websocket healthy again after self-heal via ${signal} (${formatFireWatchdogState({
        connectedAt: this.lastConnectedAt,
        lastPongAt: this.lastPongAt,
        lastInboundAt: this.lastInboundAt,
      })})`,
    );
    this.awaitingHealthySignalAt = null;
    this.healAttempts = 0;
  }

  async runOnce() {
    if (!this.wsConnected || typeof this.onForceReconnect !== "function") {
      return false;
    }
    const now = this.now();
    if (!Number.isFinite(this.lastConnectedAt) || now - this.lastConnectedAt < this.connectGraceMs) {
      return false;
    }
    const lastWsHealthAt = Math.max(this.lastPongAt || 0, this.lastInboundAt || 0, this.lastConnectedAt || 0);
    if (lastWsHealthAt && now - lastWsHealthAt <= this.staleWsMs) {
      return false;
    }
    if (this.lastHealAt && now - this.lastHealAt < this.reconnectCooldownMs) {
      return false;
    }

    this.lastHealAt = now;
    this.healAttempts += 1;
    this.awaitingHealthySignalAt = null;
    this.wsConnected = false;
    this.logger(
      `[watchdog] stale_ws_health; restarting fire websocket (${this.healAttempts}) (${formatFireWatchdogState({
        connectedAt: this.lastConnectedAt,
        lastPongAt: this.lastPongAt,
        lastInboundAt: this.lastInboundAt,
      })})`,
    );
    await this.onForceReconnect("watchdog:stale_ws_health");
    return true;
  }

  getDebugState() {
    return {
      wsConnected: this.wsConnected,
      lastConnectedAt: this.lastConnectedAt,
      lastPongAt: this.lastPongAt,
      lastInboundAt: this.lastInboundAt,
      lastHealAt: this.lastHealAt,
      healAttempts: this.healAttempts,
      awaitingHealthySignalAt: this.awaitingHealthySignalAt,
    };
  }
}

async function main() {
  const cliArgs = await parseCliArgs();
  let runtimeProjectPath = process.cwd();
  let backendSession = null;

  if (cliArgs.showHelp) {
    return;
  }

  if (cliArgs.showVersion) {
    process.stdout.write(`${CLI_NAME} version ${pkgJson.version}\n`);
    return;
  }

  const allowCliList = await loadAllowCliList(cliArgs.configFile);
  const supportedBackends = Object.keys(allowCliList);
  const discoveredBackends = await listRuntimeSupportedBackends({ configFilePath: cliArgs.configFile });
  const externalBackends = discoveredBackends.filter((backend) => !RUNTIME_SUPPORTED_BACKENDS.includes(backend));

  if (cliArgs.listBackends) {
    if (supportedBackends.length === 0 && externalBackends.length === 0) {
      process.stdout.write(`No supported backends configured.\n\nAdd allow_cli_list to your config file (~/.conductor/config.yaml):\n  allow_cli_list:\n    codex: codex --dangerously-bypass-approvals-and-sandbox\n    claude: claude --dangerously-skip-permissions\n    kimi: kimi\n    opencode: opencode\n`);
    } else {
      if (supportedBackends.length > 0) {
        process.stdout.write(`Supported backends (from config):\n`);
        for (const [name, command] of Object.entries(allowCliList)) {
          process.stdout.write(`  ${name}: ${command}\n`);
        }
      }
      if (externalBackends.length > 0) {
        process.stdout.write(`${supportedBackends.length > 0 ? "\n" : ""}External backends (from AISDK_PROVIDER_PATH):\n`);
        for (const name of externalBackends) {
          process.stdout.write(`  ${name}\n`);
        }
      }
      process.stdout.write(`\nDefault: ${supportedBackends[0] || externalBackends[0]}\n`);
    }
    return;
  }

  let resumeContext = null;
  if (cliArgs.resumeSessionId) {
    const bootstrap = await bootstrapResumeContextForFire({
      backend: cliArgs.backend,
      configFile: cliArgs.configFile,
      resumeSessionId: cliArgs.resumeSessionId,
    });
    resumeContext = bootstrap.resumeContext;
    runtimeProjectPath = bootstrap.runtimeProjectPath;
  }

  const env = buildEnv();
  const launchedByDaemon = isLaunchedByDaemon(process.env);
  let reconnectRunner = null;
  let reconnectTaskId = null;
  let pendingRemoteStopEvent = null;
  let conductor = null;
  let reconnectResumeInFlight = false;
  let fireShuttingDown = false;
  const fireWatchdog = new FireWatchdog({
    onForceReconnect: async (reason) => {
      if (!conductor || typeof conductor.forceReconnect !== "function") {
        return;
      }
      await conductor.forceReconnect(reason);
    },
    logger: log,
  });
  fireWatchdog.start();

  const scheduleReconnectRecovery = ({ isReconnect }) => {
    if (
      !shouldRunReconnectRecovery({
        isReconnect,
        fireShuttingDown,
        runner: reconnectRunner,
      })
    ) {
      return;
    }
    log("Conductor connection restored");
    if (reconnectRunner && typeof reconnectRunner.noteReconnect === "function") {
      reconnectRunner.noteReconnect();
    }
    if (!conductor || !reconnectTaskId || reconnectResumeInFlight) {
      return;
    }
    reconnectResumeInFlight = true;
    void (async () => {
      try {
        await conductor.sendAgentResume({
          active_tasks: [reconnectTaskId],
          source: "conductor-fire",
          metadata: { reconnect: true },
        });
        if (!launchedByDaemon) {
          await conductor.sendTaskStatus(reconnectTaskId, {
            status: "RUNNING",
            summary: "conductor fire reconnected",
          });
        }
      } catch (error) {
        log(`Failed to report reconnect resume: ${error?.message || error}`);
      } finally {
        reconnectResumeInFlight = false;
      }
    })();
  };

  const handleStopTaskCommand = async (event) => {
    fireWatchdog.onInbound();
    if (!event || typeof event !== "object") {
      return;
    }
    const taskId = typeof event.taskId === "string" ? event.taskId : "";
    if (reconnectTaskId && taskId && taskId !== reconnectTaskId) {
      return;
    }
    if (reconnectRunner && typeof reconnectRunner.requestStopFromRemote === "function") {
      await reconnectRunner.requestStopFromRemote(event);
      return;
    }
    pendingRemoteStopEvent = event;
  };

  if (cliArgs.configFile) {
    env.CONDUCTOR_CONFIG = cliArgs.configFile;
  }
  let configuredDaemonName = "";
  try {
    const config = loadConfig(cliArgs.configFile);
    if (config.backendUrl && !env.CONDUCTOR_BACKEND_URL) {
      env.CONDUCTOR_BACKEND_URL = config.backendUrl;
    }
    if (config.websocketUrl && !env.CONDUCTOR_WS_URL) {
      env.CONDUCTOR_WS_URL = config.websocketUrl;
    }
    if (config.agentToken && !env.CONDUCTOR_AGENT_TOKEN) {
      env.CONDUCTOR_AGENT_TOKEN = config.agentToken;
    }
    if (config.daemonName) {
      configuredDaemonName = config.daemonName;
    }
  } catch (error) {
    // Ignore config loading errors, rely on env vars or defaults
  }

  try {
    const requestedTaskTitle = resolveRequestedTaskTitle({
      cliTaskTitle: cliArgs.taskTitle,
      hasExplicitTaskTitle: cliArgs.hasExplicitTaskTitle,
      envTaskTitle: process.env.CONDUCTOR_TASK_TITLE,
      runtimeProjectPath,
    });

    conductor = await ConductorClient.connect({
      projectPath: runtimeProjectPath,
      extraEnv: env,
      extraHeaders: buildConductorConnectHeaders(),
      configFile: cliArgs.configFile,
      onConnected: (event) => {
        fireWatchdog.onConnected(event);
        scheduleReconnectRecovery(event);
      },
      onDisconnected: (event) => {
        fireWatchdog.onDisconnected();
        if (!fireShuttingDown) {
          log(`[fire-ws] Disconnected from backend: ${formatFireDisconnectDiagnostics(event)}`);
        }
      },
      onPong: (event) => {
        fireWatchdog.onPong(event);
      },
      onStopTask: handleStopTaskCommand,
    });

    const taskContext = await ensureTaskContext(conductor, {
      initialPrompt: cliArgs.initialPrompt,
      requestedProjectId: process.env.CONDUCTOR_PROJECT_ID,
      providedTaskId: process.env.CONDUCTOR_TASK_ID,
      requestedTitle: requestedTaskTitle,
      backend: cliArgs.backend,
      daemonName: configuredDaemonName,
      projectPath: runtimeProjectPath,
    });
    injectResolvedTaskId(taskContext.taskId);
    injectResolvedTaskId(taskContext.taskId, env);
    try {
      writeFireTaskMarker(taskContext.taskId, runtimeProjectPath);
    } catch (error) {
      log(`Note: Could not persist local task marker: ${error.message}`);
    }

    log(
      `Attached to Conductor task ${taskContext.taskId}${
        taskContext.appUrl ? ` (${taskContext.appUrl})` : ""
      }`,
    );
    reconnectTaskId = taskContext.taskId;

    if (typeof conductor.bindTaskSession === "function") {
      try {
        await conductor.bindTaskSession(taskContext.taskId, {
          project_id: process.env.CONDUCTOR_PROJECT_ID,
          project_path: runtimeProjectPath,
          backend_type: cliArgs.backend,
        });
      } catch {
        // best effort only
      }
    }

    const resolvedResumeSessionId = cliArgs.resumeSessionId;

    const sessionCommandLine = resolveAiSessionCommandLine(cliArgs.backend, allowCliList, process.env);

    backendSession = createAiSession(cliArgs.backend, {
      initialImages: cliArgs.initialImages,
      cwd: runtimeProjectPath,
      resumeSessionId: resolvedResumeSessionId,
      configFile: cliArgs.configFile,
      ...(sessionCommandLine ? { commandLine: sessionCommandLine } : {}),
      logger: { log },
    });

    log(`Using backend: ${cliArgs.backend}`);

    try {
      await conductor.sendAgentResume({
        active_tasks: [taskContext.taskId],
        source: "conductor-fire",
        metadata: { reconnect: false },
      });
    } catch (error) {
      log(`Failed to report agent resume: ${error?.message || error}`);
    }

    const runner = new BridgeRunner({
      backendSession,
      conductor,
      taskId: taskContext.taskId,
      pollIntervalMs: Math.max(cliArgs.pollIntervalMs, 500),
      initialPrompt: taskContext.shouldProcessInitialPrompt ? cliArgs.initialPrompt : "",
      initialPromptDelivery: taskContext.initialPromptDelivery || "none",
      includeInitialImages: Boolean(cliArgs.initialPrompt && cliArgs.initialImages.length),
      cliArgs: cliArgs.rawBackendArgs,
      backendName: cliArgs.backend,
      resumeSessionId: resolvedResumeSessionId,
      daemonName: configuredDaemonName,
    });
    reconnectRunner = runner;
    if (pendingRemoteStopEvent) {
      await runner.requestStopFromRemote(pendingRemoteStopEvent);
      pendingRemoteStopEvent = null;
    }

    const signals = new AbortController();
    let shutdownSignal = null;
    let backendShutdownRequested = false;
    const requestBackendShutdown = (source) => {
      if (backendShutdownRequested) {
        return;
      }
      backendShutdownRequested = true;
      void (async () => {
        try {
          if (backendSession && typeof backendSession.close === "function") {
            await backendSession.close();
          }
        } catch (error) {
          log(`Failed to close backend session after ${source}: ${error?.message || error}`);
        }
      })();
    };
    const onSigint = () => {
      shutdownSignal = shutdownSignal || "SIGINT";
      fireShuttingDown = true;
      signals.abort();
      requestBackendShutdown("SIGINT");
    };
    const onSigterm = () => {
      shutdownSignal = shutdownSignal || "SIGTERM";
      fireShuttingDown = true;
      signals.abort();
      requestBackendShutdown("SIGTERM");
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    if (!launchedByDaemon) {
      try {
        await conductor.sendTaskStatus(taskContext.taskId, {
          status: "RUNNING",
        });
      } catch (error) {
        log(`Failed to report task status (RUNNING): ${error?.message || error}`);
      }
    }

    let runnerError = null;
    try {
      if (!resolvedResumeSessionId && String(cliArgs.backend).trim().toLowerCase() === "codex") {
        await withFreshSessionBootstrapLock(cliArgs.backend, runtimeProjectPath, async () => {
          await runner.announceBackendSession();
        });
      }
      await runner.start(signals.signal);
    } catch (error) {
      runnerError = error;
      throw error;
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (!launchedByDaemon) {
        const remoteStopSummary = typeof runner.getRemoteStopSummary === "function" ? runner.getRemoteStopSummary() : null;
        const finalStatus = shutdownSignal
          ? {
              status: "KILLED",
              summary: `terminated by ${shutdownSignal}`,
            }
          : runnerError
            ? {
                status: "KILLED",
                summary: `conductor fire failed: ${runnerError?.message || runnerError}`,
              }
            : remoteStopSummary
              ? {
                  status: "KILLED",
                  summary: remoteStopSummary,
                }
            : {
                status: "COMPLETED",
                summary: "conductor fire exited",
              };
        try {
          const statusResult = await conductor.sendTaskStatus(taskContext.taskId, finalStatus);
          if (statusResult?.pending && typeof conductor.flushPendingUpstreamEvents === "function") {
            await conductor.flushPendingUpstreamEvents({
              timeoutMs: 5_000,
              retryIntervalMs: 250,
            });
          }
        } catch (error) {
          log(`Failed to report task status (${finalStatus.status}): ${error?.message || error}`);
        }
      }
      if (shutdownSignal === "SIGINT") {
        process.exitCode = 130;
      } else if (shutdownSignal === "SIGTERM") {
        process.exitCode = 143;
      }
    }
  } finally {
    fireShuttingDown = true;
    fireWatchdog.stop();
    if (backendSession && typeof backendSession.close === "function") {
      try {
        await backendSession.close();
      } catch (error) {
        log(`Failed to close backend session: ${error?.message || error}`);
      }
    }
    if (conductor && typeof conductor.close === "function") {
      try {
        await conductor.close();
      } catch (error) {
        log(`Failed to close conductor connection: ${error?.message || error}`);
      }
    }
  }
}

function extractConfigFileFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config-file") {
      return argv[i + 1];
    }
    if (arg.startsWith("--config-file=")) {
      return arg.slice("--config-file=".length);
    }
  }
  return undefined;
}

function hasLegacyFromFlags(argv = []) {
  return argv.some(
    (arg) =>
      arg === "--from" ||
      arg.startsWith("--from=") ||
      arg === "--from-provider" ||
      arg.startsWith("--from-provider="),
  );
}

const CONDUCTOR_BOOLEAN_FLAGS = new Set([
  "--list-backends",
  "--version",
  "-v",
  "--help",
  "-h",
]);

const CONDUCTOR_VALUE_FLAGS = new Set([
  "--backend",
  "-b",
  "--config-file",
  "--poll-interval",
  "--title",
  "-t",
  "--resume",
  "--prefill",
]);

function stripConductorArgsFromArgv(argv = []) {
  const backendArgs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] ?? "");
    if (!raw) {
      continue;
    }
    if (raw === "--") {
      backendArgs.push(...argv.slice(i + 1));
      break;
    }

    const eqIndex = raw.indexOf("=");
    const flag = eqIndex > 0 ? raw.slice(0, eqIndex) : raw;

    if (CONDUCTOR_BOOLEAN_FLAGS.has(flag)) {
      continue;
    }
    if (CONDUCTOR_VALUE_FLAGS.has(flag)) {
      if (eqIndex < 0) {
        i += 1;
      }
      continue;
    }

    backendArgs.push(raw);
  }
  return backendArgs;
}

export async function parseCliArgs(argvInput = process.argv) {
  const rawArgv = Array.isArray(argvInput) ? argvInput : process.argv;
  const argv = hideBin(rawArgv);
  const separatorIndex = argv.indexOf("--");
  
  // When no separator, parse all args first to check for conductor-specific options
  const conductorArgv = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const backendArgv = separatorIndex === -1 ? stripConductorArgsFromArgv(argv) : argv.slice(separatorIndex + 1);
  
  // Check for version/list-backends/help without separator
  const versionWithoutSeparator = separatorIndex === -1 && (argv.includes("--version") || argv.includes("-v"));
  const listBackendsWithoutSeparator = separatorIndex === -1 && argv.includes("--list-backends");
  const helpWithoutSeparator = separatorIndex === -1 && (argv.includes("--help") || argv.includes("-h"));
  if (hasLegacyFromFlags(conductorArgv)) {
    throw new Error("--from and --from-provider were removed. Use --resume <session-id>.");
  }

  const configFileFromArgs = extractConfigFileFromArgv(argv);
  const allowCliList = await loadAllowCliList(configFileFromArgs);
  const supportedBackends = Object.keys(allowCliList);
  const discoveredBackends = await listRuntimeSupportedBackends({ configFilePath: configFileFromArgs });
  const externalBackends = discoveredBackends.filter((backend) => !RUNTIME_SUPPORTED_BACKENDS.includes(backend));

  const conductorArgs = yargs(conductorArgv)
    .scriptName(CLI_NAME)
    .usage("Usage: $0 [--backend <name>] -- [backend options and prompt]")
    .version(false)
    .option("backend", {
      alias: "b",
      type: "string",
      describe: `Backend to use (loaded from config: ${supportedBackends.join(", ") || "none configured"})`,
    })
    .option("list-backends", {
      type: "boolean",
      describe: "List available backends and exit",
    })
    .option("config-file", {
      type: "string",
      describe: "Path to Conductor config file",
    })
    .option("poll-interval", {
      type: "number",
      describe: "Polling interval (ms) when waiting for Conductor messages",
    })
    .option("title", {
      alias: "t",
      type: "string",
      describe: "Optional task title shown in the app task list",
    })
    .option("resume", {
      type: "string",
      describe: "Resume from a backend session ID",
    })
    .option("prefill", {
      type: "string",
      describe: "Optional initial prompt forwarded to Conductor on task creation",
      hidden: true,
    })
    .option("version", {
      alias: "v",
      type: "boolean",
      describe: "Show Conductor CLI version and exit",
    })
    .help()
    .strict(false)
    .parserConfiguration({
      "unknown-options-as-args": true,
      "camel-case-expansion": true,
    })
    .parse();

  // Handle help early
  if (helpWithoutSeparator) {
    const defaultBackend = supportedBackends[0] || externalBackends[0] || "none";
    process.stdout.write(`${CLI_NAME} - Conductor-aware AI coding agent runner

Usage: ${CLI_NAME} [options] -- [backend options and prompt]

Options:
  -b, --backend <name>  Backend to use (from config or external providers: ${supportedBackends.join(", ") || externalBackends.join(", ") || "none configured"}) [default: ${defaultBackend}]
  --list-backends       List available configured and external backends
  --config-file <path>  Path to Conductor config file
  --poll-interval <ms>  Polling interval when waiting for Conductor messages
  -t, --title <text>    Optional task title shown in the app task list
  --resume <id>         Resume from an existing backend session
  -v, --version         Show Conductor CLI version and exit
  -h, --help            Show this help message

Config file format (~/.conductor/config.yaml):
  allow_cli_list:
    codex: codex --dangerously-bypass-approvals-and-sandbox
    claude: claude --dangerously-skip-permissions
    kimi: kimi
    opencode: opencode

Examples:
  ${CLI_NAME} -- "fix the bug"                    # Use default backend
  ${CLI_NAME} --backend claude -- "fix the bug"   # Use Claude CLI backend
  ${CLI_NAME} --backend kimi -- "fix the bug"     # Use Kimi CLI backend
  ${CLI_NAME} --backend opencode -- "fix the bug" # Use OpenCode backend
  ${CLI_NAME} --backend codex --resume <id>       # Resume Codex session
  ${CLI_NAME} --backend kimi --resume <id>        # Resume Kimi session
  ${CLI_NAME} --list-backends                     # Show configured backends
  ${CLI_NAME} --config-file ~/.conductor/config.yaml -- "fix the bug"

Environment:
  CONDUCTOR_BACKEND     Default backend
  CONDUCTOR_PROJECT_ID  Project ID to attach to
  CONDUCTOR_TASK_ID     Attach to existing task instead of creating new one
`);
    return { showHelp: true };
  }

  const backendArgs = yargs(backendArgv)
    .help(false)
    .version(false)
    .strict(false)
    .parserConfiguration({
      "unknown-options-as-args": true,
      "camel-case-expansion": true,
    })
    .parse();
  
  const backend = conductorArgs.backend
    ? await normalizeRuntimeBackendAlias(conductorArgs.backend, { configFilePath: configFileFromArgs })
    : supportedBackends[0] || externalBackends[0];
  const shouldRequireBackend =
    !Boolean(conductorArgs.listBackends) &&
    !listBackendsWithoutSeparator &&
    !Boolean(conductorArgs.version) &&
    !versionWithoutSeparator;
  const runtimeSupportedBackends = new Set(discoveredBackends);
  if (backend && !runtimeSupportedBackends.has(backend) && shouldRequireBackend) {
    throw new Error(
      `Unsupported backend "${backend}". Supported backends: ${[...runtimeSupportedBackends].join(", ") || "none configured"}.`,
    );
  }
  if (!backend && shouldRequireBackend) {
    throw new Error("No supported backends configured. Add allow_cli_list entries or set AISDK_PROVIDER_PATH for external providers.");
  }

  const prompt = (backendArgs._ || []).map((part) => String(part)).join(" ").trim();
  const initialImages = normalizeArray(backendArgs.image || backendArgs.i).map((img) => String(img));
  const pollIntervalMs = Number.isFinite(conductorArgs.pollInterval)
     ? Number(conductorArgs.pollInterval)
     : DEFAULT_POLL_INTERVAL_MS;

  const resumeRaw = conductorArgs.resume;
  if (resumeRaw === true) {
    throw new Error("--resume requires a session id");
  }
  const resumeSessionId = typeof resumeRaw === "string" ? resumeRaw.trim() : "";
  if (resumeRaw !== undefined && !resumeSessionId) {
    throw new Error("--resume requires a session id");
  }

  return {
    backend,
    initialPrompt: prompt || conductorArgs.prefill || "",
    initialImages,
    pollIntervalMs,
    rawBackendArgs: backendArgv,
    taskTitle: typeof conductorArgs.title === "string" ? conductorArgs.title.trim() : "",
    hasExplicitTaskTitle: typeof conductorArgs.title === "string" && Boolean(conductorArgs.title.trim()),
    configFile: conductorArgs.configFile,
    resumeSessionId,
    showVersion: Boolean(conductorArgs.version) || versionWithoutSeparator,
    listBackends: Boolean(conductorArgs.listBackends) || listBackendsWithoutSeparator,
  };
}

export function resolveTaskTitle(titleFlag, defaultPath = process.cwd()) {
  if (typeof titleFlag === "string" && titleFlag.trim()) {
    return titleFlag.trim();
  }
  const targetPath = typeof defaultPath === "string" ? defaultPath.trim() : "";
  const cwdName = path.basename(targetPath || process.cwd());
  return cwdName || "";
}

export function resolveRequestedTaskTitle({
  cliTaskTitle,
  hasExplicitTaskTitle,
  envTaskTitle,
  runtimeProjectPath,
}) {
  const explicit = hasExplicitTaskTitle ? cliTaskTitle : envTaskTitle;
  return resolveTaskTitle(explicit, runtimeProjectPath);
}

function normalizeTaskId(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function resolveFireStateDir(workingDirectory = process.cwd()) {
  const baseDir =
    typeof workingDirectory === "string" && workingDirectory.trim()
      ? path.resolve(workingDirectory.trim())
      : process.cwd();
  return path.join(baseDir, ".conductor", "state");
}

export function injectResolvedTaskId(taskId, env = process.env) {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) {
    return "";
  }
  env.CONDUCTOR_TASK_ID = normalizedTaskId;
  return normalizedTaskId;
}

export function writeFireTaskMarker(taskId, workingDirectory = process.cwd()) {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) {
    return "";
  }

  const stateDir = resolveFireStateDir(workingDirectory);
  const markerFileName = `${FIRE_TASK_MARKER_PREFIX}.task_${normalizedTaskId}.json`;
  const markerPath = path.join(stateDir, markerFileName);

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        source: "conductor-fire",
        taskId: normalizedTaskId,
        cwd: path.resolve(workingDirectory),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const entry of fs.readdirSync(stateDir)) {
    if (entry === markerFileName) {
      continue;
    }
    if (!entry.startsWith(`${FIRE_TASK_MARKER_PREFIX}.task_`) || !entry.endsWith(".json")) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(stateDir, entry));
    } catch {
      // ignore stale marker cleanup failures
    }
  }

  return markerPath;
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function buildEnv() {
  const env = { ...process.env };
  env.NO_PROXY = env.NO_PROXY || "127.0.0.1,localhost";
  env.no_proxy = env.no_proxy || env.NO_PROXY;
  return env;
}

async function ensureTaskContext(conductor, opts) {
  if (opts.providedTaskId) {
    return {
      taskId: opts.providedTaskId,
      appUrl: null,
      shouldProcessInitialPrompt: Boolean(opts.initialPrompt),
      initialPromptDelivery: opts.initialPrompt ? "synthetic" : "none",
    };
  }

  const projectId = await resolveProjectId(conductor, opts.requestedProjectId, {
    daemonName: opts.daemonName,
    projectPath: opts.projectPath,
  });
  const payload = {
    project_id: projectId,
    task_title: deriveTaskTitle(opts.initialPrompt, opts.requestedTitle, opts.backend),
    backend_type: opts.backend,
  };
  if (opts.daemonName) {
    payload.daemon_name = opts.daemonName;
  }
  if (opts.initialPrompt) {
    payload.prefill = opts.initialPrompt;
  }

  const session = await conductor.createTaskSession(payload);

  return {
    taskId: session.task_id,
    appUrl: session.app_url || null,
    shouldProcessInitialPrompt: Boolean(opts.initialPrompt),
    initialPromptDelivery: opts.initialPrompt ? "queued" : "none",
  };
}

export async function resolveProjectId(conductor, explicit, opts = {}) {
  if (explicit) {
    return explicit;
  }

  const daemonHost = resolveDaemonHost(opts.daemonName);
  const projectPath = typeof opts.projectPath === "string" && opts.projectPath.trim() ? opts.projectPath.trim() : process.cwd();

  if (!daemonHost) {
    return resolveDefaultProjectId(conductor);
  }

  const exists = await isExistingDirectory(projectPath);
  if (!exists) {
    throw new Error(`Workspace path does not exist: ${projectPath}`);
  }

  const snapshot = resolveWorkspaceSnapshot(projectPath);
  const projectName = deriveProjectName(snapshot);

  try {
    const matchResult = await conductor.matchProjectByPath({
      daemon_host: daemonHost,
      project_path: snapshot.projectRoot,
    });
    if (matchResult?.project_id) {
      log(`Matched project ${matchResult.project_name || matchResult.project_id} by path ${matchResult.matched_path}`);
      let resolvedProjectId = matchResult.project_id;
      try {
        const bindResult = await conductor.bindProjectPath(matchResult.project_id, {
          daemon_host: daemonHost,
          project_path: snapshot.projectRoot,
        });
        if (typeof bindResult?.project_id === "string" && bindResult.project_id.trim()) {
          resolvedProjectId = bindResult.project_id.trim();
        }
      } catch (error) {
        log(`Unable to backfill bound workspace path: ${error.message}`);
        try {
          const rebound = await conductor.matchProjectByPath({
            daemon_host: daemonHost,
            project_path: snapshot.projectRoot,
          });
          if (rebound?.project_id) {
            resolvedProjectId = rebound.project_id;
          }
        } catch {
          // ignore retry match failures
        }
      }
      return resolvedProjectId;
    }
  } catch (error) {
    log(`Unable to match project by path: ${error.message}`);
  }

  try {
    const created = await conductor.createProject({
      name: projectName,
      bindingConfirmed: true,
      daemonHost,
      workspacePath: snapshot.projectRoot,
      repoRoot: snapshot.repoRoot,
      worktreeBranch: snapshot.worktreeBranch,
      lastCommit: snapshot.lastCommit,
      fileCount: snapshot.fileCount,
    });
    if (created?.id) {
      log(`Created bound project ${created.name || created.id} for ${daemonHost}:${snapshot.projectRoot}`);
      return created.id;
    }
    throw new Error("create_project returned no id");
  } catch (error) {
    log(`Unable to create bound project: ${error.message}`);
  }

  try {
    const retryMatch = await conductor.matchProjectByPath({
      daemon_host: daemonHost,
      project_path: snapshot.projectRoot,
    });
    if (retryMatch?.project_id) {
      return retryMatch.project_id;
    }
  } catch {
    // ignore retry match failures
  }

  throw new Error(`Unable to resolve project for ${daemonHost}:${snapshot.projectRoot}`);
}

function resolveDaemonHost(daemonName) {
  if (typeof daemonName === "string" && daemonName.trim()) {
    return daemonName.trim();
  }
  const fromEnv = typeof process.env.CONDUCTOR_DAEMON_NAME === "string" ? process.env.CONDUCTOR_DAEMON_NAME.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  const fromAgent = typeof process.env.CONDUCTOR_AGENT_NAME === "string" ? process.env.CONDUCTOR_AGENT_NAME.trim() : "";
  return fromAgent;
}

function resolveWorkspaceSnapshot(projectPath) {
  try {
    const context = new ProjectContext(projectPath);
    return context.snapshot();
  } catch {
    return {
      projectRoot: path.resolve(projectPath),
    };
  }
}

function deriveProjectName(snapshot) {
  const basePath = snapshot.repoRoot || snapshot.projectRoot;
  const name = basePath ? path.basename(basePath) : "";
  const baseName = name || "New Project";
  const digest = createHash("sha1").update(basePath || baseName).digest("hex").slice(0, 8);
  return `${baseName}-${digest}`;
}

async function resolveDefaultProjectId(conductor) {
  try {
    const listing = await conductor.listProjects();
    const defaultProject = Array.isArray(listing?.projects)
      ? listing.projects.find((project) => Boolean(project?.isDefault))
      : null;
    if (defaultProject?.id) {
      return defaultProject.id;
    }
  } catch {
    // ignore list failures
  }

  log("No bound daemon available; creating default project...");
  try {
    const created = await conductor.createProject({
      name: "Default Project",
      isDefault: true,
    });
    if (created?.id) {
      log(`Created default project ${created.id}`);
      return created.id;
    }
    throw new Error("create_project returned no id");
  } catch (error) {
    throw new Error(`Unable to resolve project and failed to create default: ${error.message}`);
  }
}

function deriveTaskTitle(prompt, explicit, backend = "codex") {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  if (prompt) {
    const compact = prompt.replace(/\s+/g, " ").trim();
    if (compact) {
      return compact.slice(0, 80);
    }
  }
  const backendName = backend.charAt(0).toUpperCase() + backend.slice(1);
  return `${backendName} Task`;
}

export function buildResumeArgsForBackend(backend, sessionId) {
  return buildCliResumeArgsForBackend(backend, sessionId);
}

export function resumeProviderForBackend(backend) {
  return resumeProviderForCliBackend(backend);
}

export async function resolveSessionRunDirectory(sessionPath) {
  return resolveCliSessionRunDirectory(sessionPath);
}

async function isExistingDirectory(targetPath) {
  const normalizedPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!normalizedPath) {
    return false;
  }
  try {
    const stats = await fs.promises.stat(normalizedPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function resolveResumeContext(backend, sessionId, options = {}) {
  return resolveCliResumeContext(backend, sessionId, options);
}

export async function bootstrapResumeContextForFire({
  backend,
  configFile,
  resumeSessionId,
  env = process.env,
  resolveResumeContextFn = resolveResumeContext,
  applyWorkingDirectoryFn = applyWorkingDirectory,
  logger = log,
}) {
  let runtimeProjectPath = process.cwd();
  let resumeContext = null;

  if (!resumeSessionId) {
    return { resumeContext, runtimeProjectPath };
  }

  const overrideResumeCwd =
    typeof env?.CONDUCTOR_RESUME_CWD === "string" ? env.CONDUCTOR_RESUME_CWD.trim() : "";
  if (overrideResumeCwd) {
    logger(`Using CONDUCTOR_RESUME_CWD override for --resume ${resumeSessionId}: ${overrideResumeCwd}`);
    runtimeProjectPath = await applyWorkingDirectoryFn(overrideResumeCwd);
    logger(`Switched working directory to ${runtimeProjectPath} before Conductor connect`);
    return { resumeContext, runtimeProjectPath };
  }

  resumeContext = await resolveResumeContextFn(backend, resumeSessionId, {
    configFilePath: configFile,
  });
  const sessionLocation = resumeContext.sessionPath ? ` at ${resumeContext.sessionPath}` : "";
  logger(`Validated --resume ${resumeContext.sessionId} (${resumeContext.provider})${sessionLocation}`);
  logger(`Resume will run backend from ${resumeContext.cwd}`);
  runtimeProjectPath = await applyWorkingDirectoryFn(resumeContext.cwd);
  logger(`Switched working directory to ${runtimeProjectPath} before Conductor connect`);
  return { resumeContext, runtimeProjectPath };
}

export async function applyWorkingDirectory(targetPath) {
  const normalizedPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!normalizedPath) {
    throw new Error("Cannot switch working directory: empty path");
  }
  if (!(await isExistingDirectory(normalizedPath))) {
    throw new Error(`Cannot switch working directory: ${normalizedPath}`);
  }
  try {
    process.chdir(normalizedPath);
    process.env.PWD = process.cwd();
  } catch (error) {
    throw new Error(`Cannot switch working directory to ${normalizedPath}: ${error?.message || error}`);
  }
  return process.cwd();
}

function truncateText(value, maxLen = 240) {
  if (!value) return "";
  const text = String(value).trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function isTruthyEnv(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSessionClosedError(error) {
  return Boolean(error && typeof error === "object" && error.reason === "session_closed");
}

function sanitizeForLog(value, maxLen = 180) {
  if (!value) return "";
  return truncateText(String(value).replace(/\s+/g, " ").trim(), maxLen);
}

function getBoundedEnvInt(envName, fallback, min, max) {
  const fallbackNumber = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackNumber)
    ? Math.min(Math.max(Math.round(fallbackNumber), min), max)
    : min;
  const raw = process.env[envName];
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return normalizedFallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function normalizeExecutionErrorKey(errorMessage) {
  const normalized = sanitizeForLog(errorMessage, 280).toLowerCase();
  if (!normalized) {
    return "unknown_error";
  }
  if (normalized.includes("pty session already spawned")) {
    return "pty_session_already_spawned";
  }
  if (normalized.includes("tui process has exited")) {
    return "tui_process_exited";
  }
  if (normalized.includes("cannot proceed: tui process has exited")) {
    return "cannot_proceed_tui_exited";
  }
  if (normalized.includes("turn exceeded hard deadline")) {
    return "turn_timeout";
  }
  return normalized;
}

export class BridgeRunner {
  constructor({
    backendSession,
    conductor,
    taskId,
    pollIntervalMs,
    initialPrompt,
    initialPromptDelivery,
    includeInitialImages,
    cliArgs,
    backendName,
    resumeSessionId,
    daemonName,
  }) {
    this.backendSession = backendSession;
    this.conductor = conductor;
    this.taskId = taskId;
    this.pollIntervalMs = pollIntervalMs;
    this.initialPrompt = initialPrompt;
    this.initialPromptDelivery =
      typeof initialPromptDelivery === "string" && initialPromptDelivery.trim()
        ? initialPromptDelivery.trim()
        : "none";
    this.includeInitialImages = includeInitialImages;
    this.cliArgs = cliArgs;
    this.backendName = backendName || "codex";
    this.resumeSessionId =
      typeof resumeSessionId === "string" && resumeSessionId.trim()
        ? resumeSessionId.trim()
        : "";
    this.isCopilotBackend = String(this.backendName).toLowerCase() === "copilot";
    this.copilotDebug =
      this.isCopilotBackend &&
      (isTruthyEnv(process.env.CONDUCTOR_COPILOT_DEBUG) || isTruthyEnv(process.env.CONDUCTOR_DEBUG));
    this.stopped = false;
    this.runningTurn = false;
    this.processedMessageIds = new Set();
    this.inFlightMessageIds = new Set();
    this.pendingInitialPrompt =
      this.initialPromptDelivery === "queued" && typeof initialPrompt === "string" && initialPrompt.trim()
        ? initialPrompt.trim()
        : "";
    this.sessionStreamReplyCounts = new Map();
    this.lastRuntimeStatusSignature = null;
    this.lastRuntimeStatusPayload = null;
    this.runtimeContextSnapshot = null;
    this.runtimeContextSnapshotAt = 0;
    this.runtimeContextInFlight = null;
    this.runtimeContextRefreshMs = getBoundedEnvInt(
      "CONDUCTOR_RUNTIME_CONTEXT_REFRESH_MS",
      2000,
      500,
      60 * 1000,
    );
    this.useSessionFileReplyStream =
      Boolean(this.backendSession) &&
      typeof this.backendSession.usesSessionFileReplyStream === "function" &&
      this.backendSession.usesSessionFileReplyStream();
    this.daemonName =
      (typeof daemonName === "string" && daemonName.trim()) ||
      (typeof process.env.CONDUCTOR_AGENT_NAME === "string" && process.env.CONDUCTOR_AGENT_NAME.trim()) ||
      (typeof process.env.CONDUCTOR_DAEMON_NAME === "string" && process.env.CONDUCTOR_DAEMON_NAME.trim()) ||
      (typeof process.env.HOSTNAME === "string" && process.env.HOSTNAME.trim()) ||
      os.hostname();
    this.needsReconnectRecovery = false;
    this.remoteStopInfo = null;
    this.sessionAnnouncementSent = false;
    this.boundSessionId = "";
    this.errorLoop = null;
    this.errorLoopWindowMs = getBoundedEnvInt(
      "CONDUCTOR_ERROR_LOOP_WINDOW_MS",
      DEFAULT_ERROR_LOOP_WINDOW_MS,
      15 * 1000,
      30 * 60 * 1000,
    );
    this.errorLoopBackoffMs = getBoundedEnvInt(
      "CONDUCTOR_ERROR_LOOP_BACKOFF_MS",
      DEFAULT_ERROR_LOOP_BACKOFF_MS,
      15 * 1000,
      60 * 60 * 1000,
    );
    this.errorLoopThreshold = getBoundedEnvInt(
      "CONDUCTOR_ERROR_LOOP_THRESHOLD",
      DEFAULT_ERROR_LOOP_THRESHOLD,
      2,
      20,
    );
    if (
      this.useSessionFileReplyStream &&
      typeof this.backendSession?.setSessionMessageHandler === "function"
    ) {
      this.backendSession.setSessionMessageHandler((payload) =>
        this.handleSessionFileAssistantMessage(payload),
      );
    }
    if (
      this.useSessionFileReplyStream &&
      typeof this.backendSession?.setWorkingStatusHandler === "function"
    ) {
      this.backendSession.setWorkingStatusHandler((payload) =>
        this.handleContinuousWorkingStatus(payload),
      );
    }
  }

  copilotLog(message) {
    if (!this.copilotDebug) {
      return;
    }
    log(`[copilot-debug] task=${this.taskId} ${message}`);
  }

  async announceBackendSession() {
    if (this.sessionAnnouncementSent) {
      return;
    }
    if (!this.backendSession || typeof this.backendSession.ensureSessionInfo !== "function") {
      return;
    }
    let sessionInfo = null;
    try {
      sessionInfo = await this.backendSession.ensureSessionInfo();
    } catch (error) {
      this.copilotLog(`session announce skipped: ${sanitizeForLog(error?.message || error, 160)}`);
      return;
    }
    const discoveredSessionId = String(sessionInfo?.sessionId || "").trim();
    const fallbackSessionId = this.resumeSessionId;
    const sessionId = discoveredSessionId || fallbackSessionId;
    const sessionFilePath = sessionInfo?.sessionFilePath ? String(sessionInfo.sessionFilePath).trim() : "";
    const sessionModel =
      sessionInfo?.model && String(sessionInfo.model).trim()
        ? String(sessionInfo.model).trim()
        : this.backendSession.threadOptions?.model || this.backendName;
    const sessionModelProvider =
      sessionInfo?.modelProvider && String(sessionInfo.modelProvider).trim()
        ? String(sessionInfo.modelProvider).trim()
        : this.backendSession.threadOptions?.modelProvider || undefined;
    const hasRealSessionId = Boolean(sessionId);
    const messageSuffix = [
      sessionModel ? `model=${sessionModel}` : "",
      sessionModelProvider ? `provider=${sessionModelProvider}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const message = hasRealSessionId
      ? `${this.backendName} session started: ${sessionId}${messageSuffix ? ` (${messageSuffix})` : ""}`
      : `${this.backendName} session started${messageSuffix ? ` (${messageSuffix})` : ""}`;
    if (hasRealSessionId) {
      await this.persistTaskSessionBinding({
        sessionId,
        sessionFilePath,
      });
    }
    try {
      await this.conductor.sendMessage(this.taskId, message, {
        backend: this.backendName,
        model: sessionModel || undefined,
        model_provider: sessionModelProvider || undefined,
        thread_id: hasRealSessionId ? sessionId : undefined,
        session_id: hasRealSessionId ? sessionId : undefined,
        session_file_path: sessionFilePath || undefined,
        cli_args: this.cliArgs,
        synthetic: true,
      });
      this.sessionAnnouncementSent = true;
      this.copilotLog(hasRealSessionId ? `session announced id=${sessionId}` : "session announced without id");
      await this.reportRuntimeStatus(
        {
          state: this.useSessionFileReplyStream ? undefined : "WAIT_READY",
          phase: "session_started",
          source: "ai-sdk",
          reply_in_progress: false,
          status_done_line: this.useSessionFileReplyStream
            ? undefined
            : `${this.backendName} session started`,
          backend: this.backendName,
          thread_id: hasRealSessionId ? sessionId : undefined,
          session_id: hasRealSessionId ? sessionId : undefined,
          session_file_path: sessionFilePath || undefined,
        },
        undefined,
      );
    } catch (error) {
      log(`Failed to send session announcement: ${error?.message || error}`);
    }
  }

  async persistTaskSessionBinding({ sessionId, sessionFilePath } = {}) {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId || normalizedSessionId === this.boundSessionId) {
      return false;
    }
    if (typeof this.conductor?.bindTaskSession !== "function") {
      return false;
    }
    try {
      await this.conductor.bindTaskSession(this.taskId, {
        session_id: normalizedSessionId,
        session_file_path:
          typeof sessionFilePath === "string" && sessionFilePath.trim() ? sessionFilePath.trim() : undefined,
        backend_type: this.backendName,
      });
      this.boundSessionId = normalizedSessionId;
      return true;
    } catch (error) {
      log(`Failed to persist task session binding for ${this.taskId}: ${error?.message || error}`);
      return false;
    }
  }

  async syncBackendSessionBinding() {
    if (!this.backendSession) {
      return false;
    }
    let sessionInfo = null;
    try {
      if (typeof this.backendSession.getSessionInfo === "function") {
        sessionInfo = this.backendSession.getSessionInfo();
      }
      if (!sessionInfo && typeof this.backendSession.ensureSessionInfo === "function") {
        sessionInfo = await this.backendSession.ensureSessionInfo();
      }
    } catch (error) {
      this.copilotLog(`session binding sync skipped: ${sanitizeForLog(error?.message || error, 160)}`);
      return false;
    }
    return this.persistTaskSessionBinding({
      sessionId: sessionInfo?.sessionId,
      sessionFilePath: sessionInfo?.sessionFilePath,
    });
  }

  async start(abortSignal) {
    abortSignal?.addEventListener("abort", () => {
      this.stopped = true;
    });
    if (this.stopped) {
      return;
    }

    await this.announceBackendSession();
    if (this.stopped) {
      return;
    }

    if (this.initialPrompt && this.initialPromptDelivery === "synthetic") {
      this.copilotLog("processing initial prompt via synthetic attach flow");
      await this.handleSyntheticMessage(this.initialPrompt, {
        includeImages: this.includeInitialImages,
      });
    }
    if (this.stopped) {
      return;
    }

    while (!this.stopped) {
      if (this.needsReconnectRecovery && !this.runningTurn) {
        await this.recoverAfterReconnect();
      }
      let processed = false;
      try {
        processed = await this.processIncomingBatch();
      } catch (error) {
        if (this.stopped && (this.remoteStopInfo || isSessionClosedError(error))) {
          break;
        }
        log(`Error while processing messages: ${error.message}`);
        await this.reportError(`处理任务失败: ${error.message}`);
      }
      if (!processed && !this.stopped) {
        await delay(this.pollIntervalMs);
      }
    }
  }

  noteReconnect() {
    this.needsReconnectRecovery = true;
  }

  shouldSuppressReconnectRecovery() {
    return this.stopped || Boolean(this.remoteStopInfo);
  }

  getRemoteStopSummary() {
    if (!this.remoteStopInfo) {
      return null;
    }
    const reason = this.remoteStopInfo.reason || "killed by app";
    return `task stopped by app: ${reason}`;
  }

  async requestStopFromRemote(event = {}) {
    const taskId = typeof event.taskId === "string" ? event.taskId.trim() : "";
    if (taskId && taskId !== this.taskId) {
      return;
    }
    const requestId = typeof event.requestId === "string" ? event.requestId.trim() : "";
    const reason = typeof event.reason === "string" ? event.reason.trim() : "";
    if (!this.remoteStopInfo) {
      this.remoteStopInfo = {
        requestId: requestId || null,
        reason: reason || null,
      };
      log(
        `Received stop_task for ${this.taskId}${
          reason ? ` (${reason})` : ""
        }; stopping conductor fire`,
      );
    }
    this.stopped = true;
    if (typeof this.backendSession?.close === "function") {
      try {
        await this.backendSession.close();
      } catch (error) {
        log(`Failed to stop backend session for ${this.taskId}: ${error?.message || error}`);
      }
    }
  }

  async recoverAfterReconnect() {
    if (!this.needsReconnectRecovery) {
      return;
    }
    this.needsReconnectRecovery = false;
    log(`Recovering task ${this.taskId} after reconnect`);
    // User-message recovery relies on the durable server outbox. DB-history replay
    // stays opt-in here only as a legacy/debugging fallback after reconnect.
    if (process.env.CONDUCTOR_FIRE_RECONNECT_BACKFILL === "1") {
      await this.backfillPendingUserMessages();
    }
    await this.replayLastRuntimeStatus();
  }

  async processIncomingBatch() {
    const result = await this.conductor.receiveMessages(this.taskId, 20);
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    if (messages.length === 0) {
      return false;
    }
    const ackToken = result.next_ack_token || result.nextAckToken;
    this.copilotLog(
      `received batch size=${messages.length} hasMore=${Boolean(result?.has_more)} ackToken=${ackToken ? "yes" : "no"} roles=${messages
        .map((item) => String(item?.role || "unknown").toLowerCase())
        .join(",")}`,
    );

    for (const message of messages) {
      if (this.stopped) {
        break;
      }
      if (!this.shouldRespond(message)) {
        this.copilotLog(`skip message role=${String(message?.role || "unknown").toLowerCase()}`);
        continue;
      }
      await this.respondToMessage(message);
    }

    if (ackToken) {
      await this.conductor.ackMessages(this.taskId, ackToken);
      this.copilotLog(`acked batch ackToken=${truncateText(String(ackToken), 40)}`);
    }
    const hasMore = Boolean(result?.has_more);
    return hasMore;
  }

  shouldRespond(message) {
    if (!message || typeof message !== "object") {
      return false;
    }
    const role = String(message.role || "").toLowerCase();
    return role === "user" || role === "action";
  }

  normalizeMessageHistoryPayload(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && typeof payload === "object" && Array.isArray(payload.messages)) {
      return payload.messages;
    }
    return [];
  }

  async backfillPendingUserMessages() {
    const backendUrl = process.env.CONDUCTOR_BACKEND_URL;
    const token = process.env.CONDUCTOR_AGENT_TOKEN;
    if (!backendUrl || !token) {
      this.copilotLog("skip backfill: missing backend url or token");
      return;
    }

    try {
      const response = await fetch(
        `${backendUrl.replace(/\/+$/, "")}/api/tasks/${this.taskId}/messages`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
      );
      if (!response.ok) {
        this.copilotLog(`backfill request failed status=${response.status}`);
        return;
      }
      const history = this.normalizeMessageHistoryPayload(await response.json());
      if (!Array.isArray(history) || history.length === 0) {
        this.copilotLog("backfill: no history messages");
        return;
      }

      let lastSdkIndex = -1;
      for (let i = 0; i < history.length; i += 1) {
        const role = String(history[i]?.role || "").toLowerCase();
        if (role === "sdk" || role === "assistant") {
          lastSdkIndex = i;
        }
      }

      const historyUserIds = history
        .filter((item) => String(item?.role || "").toLowerCase() === "user")
        .map((item) => (item?.id ? String(item.id) : ""))
        .filter(Boolean);

      const handledUserIds = history
        .slice(0, lastSdkIndex + 1)
        .filter((item) => String(item?.role || "").toLowerCase() === "user")
        .map((item) => (item?.id ? String(item.id) : ""))
        .filter(Boolean);

      for (const handledId of handledUserIds) {
        this.processedMessageIds.add(handledId);
      }

      const pendingUserMessages = history
        .slice(lastSdkIndex + 1)
        .filter((item) => String(item?.role || "").toLowerCase() === "user")
        .filter((item) => typeof item?.content === "string" && item.content.trim());

      this.copilotLog(
        `backfill loaded history=${history.length} handledUsers=${handledUserIds.length} pendingUsers=${pendingUserMessages.length} lastSdkIndex=${lastSdkIndex}`,
      );

      for (const pending of pendingUserMessages) {
        this.copilotLog(`backfill replay message id=${pending.id ? String(pending.id) : "unknown"}`);
        await this.respondToMessage({
          message_id: pending.id ? String(pending.id) : undefined,
          role: "user",
          content: pending.content,
        });
      }
    } catch (error) {
      log(`Failed to backfill messages: ${error.message}`);
    }
  }

  normalizePercent(value) {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 100) {
      return 100;
    }
    return value;
  }

  async resolveRuntimeContext() {
    const now = Date.now();
    if (
      this.runtimeContextSnapshot &&
      now - this.runtimeContextSnapshotAt < this.runtimeContextRefreshMs
    ) {
      return this.runtimeContextSnapshot;
    }
    if (this.runtimeContextInFlight) {
      return this.runtimeContextInFlight;
    }

    this.runtimeContextInFlight = (async () => {
      let sessionInfo = null;
      try {
        if (typeof this.backendSession?.getSessionInfo === "function") {
          sessionInfo = this.backendSession.getSessionInfo();
        }
      } catch {
        sessionInfo = null;
      }

      let usage = null;
      try {
        if (typeof this.backendSession?.getSessionUsageSummary === "function") {
          usage = await this.backendSession.getSessionUsageSummary();
        }
      } catch {
        usage = null;
      }

      const resolvedSessionId = String(
        usage?.sessionId || sessionInfo?.sessionId || "",
      ).trim();
      const resolvedSessionFilePath = String(
        usage?.sessionFilePath || sessionInfo?.sessionFilePath || "",
      ).trim();
      const tokenUsagePercent = this.normalizePercent(Number(usage?.tokenUsagePercent));
      const contextUsagePercent = this.normalizePercent(Number(usage?.contextUsagePercent));

      const snapshot = {
        daemon: this.daemonName || undefined,
        pid: process.pid,
        session_id: resolvedSessionId || undefined,
        session_file_path: resolvedSessionFilePath || undefined,
        token_usage_percent: tokenUsagePercent,
        context_usage_percent: contextUsagePercent,
      };
      this.runtimeContextSnapshot = snapshot;
      this.runtimeContextSnapshotAt = Date.now();
      return snapshot;
    })();

    try {
      return await this.runtimeContextInFlight;
    } finally {
      this.runtimeContextInFlight = null;
    }
  }

  createRuntimeStatus(payload, replyTo, runtimeContext = null) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const state = payload.state ? String(payload.state) : "";
    const phase = payload.phase ? String(payload.phase) : "";
    const statusLine = payload.status_line ? String(payload.status_line) : "";
    const statusDoneLine = payload.status_done_line ? String(payload.status_done_line) : "";
    const replyPreview = payload.reply_preview ? String(payload.reply_preview) : "";

    if (!state && !phase && !statusLine && !statusDoneLine && !replyPreview) {
      return null;
    }

    return {
      state: state || undefined,
      phase: phase || undefined,
      source: payload.source ? String(payload.source) : "ai-sdk",
      reply_in_progress: Boolean(payload.reply_in_progress),
      status_line: statusLine || undefined,
      status_done_line: statusDoneLine || undefined,
      reply_preview: truncateText(replyPreview, 240) || undefined,
      reply_to: replyTo,
      backend: this.backendName,
      thread_id:
        String(
          payload.thread_id || payload.session_id || runtimeContext?.session_id || "",
        ).trim() || undefined,
      daemon: runtimeContext?.daemon,
      pid: runtimeContext?.pid,
      session_id:
        String(payload.session_id || runtimeContext?.session_id || "").trim() || undefined,
      session_file_path: payload.session_file_path || runtimeContext?.session_file_path,
      token_usage_percent: runtimeContext?.token_usage_percent,
      context_usage_percent: runtimeContext?.context_usage_percent,
    };
  }

  async reportRuntimeStatus(payload, replyTo) {
    const runtimeContext = await this.resolveRuntimeContext();
    const runtime = this.createRuntimeStatus(payload, replyTo, runtimeContext);
    if (!runtime) {
      return;
    }

    const signature = JSON.stringify(runtime);
    if (signature === this.lastRuntimeStatusSignature) {
      return;
    }
    this.lastRuntimeStatusSignature = signature;
    this.lastRuntimeStatusPayload = {
      ...runtime,
    };
    this.copilotLog(
      `runtime replyTo=${replyTo || "latest"} state=${runtime.state || ""} phase=${runtime.phase || ""} inProgress=${Boolean(
        runtime.reply_in_progress,
      )} status="${sanitizeForLog(runtime.status_line || "", 120)}" done="${sanitizeForLog(runtime.status_done_line || "", 120)}" preview="${sanitizeForLog(runtime.reply_preview || "", 120)}" model="${sanitizeForLog(this.backendSession.threadOptions?.model || this.backendName, 80)}" provider="${sanitizeForLog(this.backendSession.threadOptions?.modelProvider || this.backendName, 80)}"`,
    );

    try {
      await this.conductor.sendRuntimeStatus(this.taskId, {
        ...runtime,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      log(`Failed to report runtime status: ${error?.message || error}`);
    }
  }

  async replayLastRuntimeStatus() {
    if (!this.lastRuntimeStatusPayload) {
      return;
    }
    try {
      await this.conductor.sendRuntimeStatus(this.taskId, {
        ...this.lastRuntimeStatusPayload,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      log(`Failed to replay runtime status after reconnect: ${error?.message || error}`);
    }
  }

  async handleSessionFileAssistantMessage(payload) {
    if (this.stopped) {
      return;
    }
    const preserveWhitespace = Boolean(payload?.preserveWhitespace);
    const rawText = typeof payload?.text === "string" ? payload.text : "";
    const text = preserveWhitespace ? rawText : rawText.trim();
    if (!text || (!preserveWhitespace && !text.trim())) {
      return;
    }

    const replyTo = typeof payload?.replyTo === "string" ? payload.replyTo.trim() : "";
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    const sessionFilePath =
      typeof payload?.sessionFilePath === "string" ? payload.sessionFilePath.trim() : "";

    await this.sendSessionStreamMessage({
      text,
      replyTo,
      sessionId,
      sessionFilePath,
      timestamp: payload?.timestamp,
    });
  }

  async sendSessionStreamMessage({
    text,
    replyTo,
    sessionId,
    sessionFilePath,
    timestamp,
  }) {
    const normalizedText = typeof text === "string" ? text : "";
    if (!normalizedText) {
      return;
    }

    await this.persistTaskSessionBinding({
      sessionId,
      sessionFilePath,
    });

    logBackendReply(this.backendName, normalizedText, {
      usage: null,
      replyTo: replyTo || "latest",
    });
    await this.conductor.sendMessage(this.taskId, normalizedText, {
      model: this.backendSession.threadOptions?.model || this.backendName,
      backend: this.backendName,
      thread_id: sessionId || this.backendSession.threadId,
      session_id: sessionId || undefined,
      session_file_path: sessionFilePath || undefined,
      reply_to: replyTo || undefined,
      cli_args: this.cliArgs,
      session_stream: true,
      timestamp: timestamp || undefined,
    });
    const replyKey = this.normalizeSessionStreamReplyKey(replyTo);
    this.sessionStreamReplyCounts.set(
      replyKey,
      Number(this.sessionStreamReplyCounts.get(replyKey) || 0) + 1,
    );
    this.copilotLog(
      `session_file sdk_message sent replyTo=${replyTo || "latest"} responseLen=${normalizedText.length}`,
    );
  }

  async handleContinuousWorkingStatus(payload) {
    await this.reportRuntimeStatus(payload, payload?.replyTo);
  }

  normalizeSessionStreamReplyKey(replyTo) {
    const normalizedReplyTo = typeof replyTo === "string" ? replyTo.trim() : "";
    return normalizedReplyTo || "__latest__";
  }

  getSessionStreamReplyCount(replyTo) {
    return Number(
      this.sessionStreamReplyCounts.get(this.normalizeSessionStreamReplyKey(replyTo)) || 0,
    );
  }

  isCodexCheckpointUnavailableError(errorMessage) {
    return String(errorMessage || "")
      .toLowerCase()
      .includes("codex session file checkpoint unavailable");
  }

  async settleCodexCheckpointUnavailableAfterStream(replyTo, errorMessage, { markProcessed = true } = {}) {
    if (!this.useSessionFileReplyStream) {
      return false;
    }
    if (String(this.backendName || "").toLowerCase() !== "codex") {
      return false;
    }
    if (!this.isCodexCheckpointUnavailableError(errorMessage)) {
      return false;
    }
    const streamedReplyCount = this.getSessionStreamReplyCount(replyTo);
    if (streamedReplyCount <= 0) {
      return false;
    }

    this.copilotLog(
      `suppress checkpoint unavailable after streamed replies replyTo=${replyTo || "latest"} count=${streamedReplyCount}`,
    );
    await this.reportRuntimeStatus(
      {
        phase: "session_stream_settled",
        reply_in_progress: false,
      },
      replyTo,
    );
    if (markProcessed && replyTo) {
      this.processedMessageIds.add(replyTo);
    }
    this.resetErrorLoop();
    return true;
  }

  resetErrorLoop() {
    this.errorLoop = null;
  }

  evaluateErrorLoop(errorMessage) {
    const normalizedKey = normalizeExecutionErrorKey(errorMessage);
    const now = Date.now();
    const current = this.errorLoop;

    if (
      !current ||
      current.key !== normalizedKey ||
      now - current.lastAt > this.errorLoopWindowMs
    ) {
      this.errorLoop = {
        key: normalizedKey,
        count: 1,
        lastAt: now,
        cooldownUntil: 0,
      };
      return {
        key: normalizedKey,
        count: 1,
        open: false,
        suppressReport: false,
        cooldownMs: 0,
      };
    }

    current.count += 1;
    current.lastAt = now;
    const open = current.count >= this.errorLoopThreshold;
    let suppressReport = false;

    if (open) {
      if (current.cooldownUntil > now) {
        suppressReport = true;
      } else {
        current.cooldownUntil = now + this.errorLoopBackoffMs;
      }
    }

    this.errorLoop = current;
    return {
      key: normalizedKey,
      count: current.count,
      open,
      suppressReport,
      cooldownMs: suppressReport ? current.cooldownUntil - now : 0,
    };
  }

  isExecutionFailureLoopError(errorMessage) {
    const normalized = String(errorMessage || "").toLowerCase();
    return (
      normalized.includes("pty session already spawned") ||
      normalized.includes("tui process has exited") ||
      normalized.includes("cannot proceed: tui process has exited")
    );
  }

  async respondToMessage(message) {
    const content = String(message.content || "").trim();
    if (!content) {
      this.copilotLog(`skip empty message replyTo=${message?.message_id || "latest"}`);
      return;
    }
    const replyTo = message.message_id;
    if (replyTo && this.processedMessageIds.has(replyTo)) {
      this.copilotLog(`skip duplicated message replyTo=${replyTo}`);
      return;
    }
    if (replyTo && this.inFlightMessageIds.has(replyTo)) {
      this.copilotLog(`skip in-flight duplicated message replyTo=${replyTo}`);
      return;
    }
    if (replyTo) {
      this.inFlightMessageIds.add(replyTo);
    }
    const isQueuedInitialPromptMessage =
      Boolean(this.pendingInitialPrompt) &&
      String(message.role || "").toLowerCase() === "user" &&
      content === this.pendingInitialPrompt;
    const useInitialImages = isQueuedInitialPromptMessage && this.includeInitialImages;
    if (
      this.useSessionFileReplyStream &&
      typeof this.backendSession?.setSessionReplyTarget === "function"
    ) {
      this.backendSession.setSessionReplyTarget(replyTo);
    }
    this.lastRuntimeStatusSignature = null;
    this.runningTurn = true;
    const turnStartedAt = Date.now();
    let turnWatchdog = null;
    if (this.isCopilotBackend) {
      turnWatchdog = setInterval(() => {
        const runtime = this.lastRuntimeStatusPayload || {};
        this.copilotLog(
          `turn waiting replyTo=${replyTo || "latest"} elapsedMs=${Date.now() - turnStartedAt} state=${runtime.state || ""} phase=${runtime.phase || ""} status="${sanitizeForLog(runtime.status_line || runtime.status_done_line || "", 120)}"`,
        );
      }, 30000);
      if (typeof turnWatchdog.unref === "function") {
        turnWatchdog.unref();
      }
    }
    this.copilotLog(
      `turn start replyTo=${replyTo || "latest"} role=${String(message.role || "").toLowerCase()} contentLen=${content.length} preview="${sanitizeForLog(content, 120)}"`,
    );
    log(`Processing message ${replyTo} (${message.role})`);
    try {
      if (this.useSessionFileReplyStream) {
        await this.reportRuntimeStatus(
          {
            phase: "start_turn",
            reply_in_progress: true,
          },
          replyTo,
        );
      } else {
        await this.reportRuntimeStatus(
          {
            state: "PREPARE_TURN",
            phase: "start_turn",
            reply_in_progress: true,
            status_line: `${this.backendName} is preparing the response`,
          },
          replyTo,
        );
      }

      const result = await this.backendSession.runTurn(content, {
        useInitialImages,
        onProgress: (payload) => {
          void this.reportRuntimeStatus(payload, replyTo);
        },
      });
      this.copilotLog(
        `runTurn completed replyTo=${replyTo || "latest"} elapsedMs=${Date.now() - turnStartedAt} answerLen=${String(
          result.text || "",
        ).trim().length} items=${Array.isArray(result.items) ? result.items.length : 0}`,
      );

      if (!this.useSessionFileReplyStream) {
        await this.reportRuntimeStatus(
          {
            state: "DONE",
            phase: "reply_ready",
            reply_in_progress: false,
            status_done_line: `${this.backendName} finished`,
          },
          replyTo,
        );
      }

      if (!this.useSessionFileReplyStream) {
        const responseText =
          result.text ||
          extractAgentTextFromItems(result.items) ||
          extractAgentTextFromMetadata(result.metadata) ||
          `(${this.backendName} 未返回任何文本)`;
        logBackendReply(this.backendName, responseText, { usage: result.usage, replyTo: replyTo || "latest" });
        await this.conductor.sendMessage(this.taskId, responseText, {
          model: this.backendSession.threadOptions?.model || this.backendName,
          backend: this.backendName,
          usage: result.usage || null,
          thread_id: this.backendSession.threadId,
          items: result.items,
          reply_to: replyTo,
          cli_args: this.cliArgs,
        });
      }
      await this.syncBackendSessionBinding();
      if (replyTo) {
        this.processedMessageIds.add(replyTo);
      }
      if (isQueuedInitialPromptMessage) {
        this.pendingInitialPrompt = "";
      }
      this.resetErrorLoop();
      if (this.useSessionFileReplyStream) {
        this.copilotLog(`session_file turn settled replyTo=${replyTo || "latest"}`);
      } else {
        const responseText =
          result.text ||
          extractAgentTextFromItems(result.items) ||
          extractAgentTextFromMetadata(result.metadata) ||
          `(${this.backendName} 未返回任何文本)`;
        this.copilotLog(`sdk_message sent replyTo=${replyTo || "latest"} responseLen=${responseText.length}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.stopped && (this.remoteStopInfo || isSessionClosedError(error))) {
        this.copilotLog(
          `turn interrupted by stop_task replyTo=${replyTo || "latest"} elapsedMs=${Date.now() - turnStartedAt}`,
        );
        return;
      }
      if (await this.settleCodexCheckpointUnavailableAfterStream(replyTo, errorMessage)) {
        return;
      }
      this.copilotLog(
        `turn failed replyTo=${replyTo || "latest"} elapsedMs=${Date.now() - turnStartedAt} error="${sanitizeForLog(errorMessage, 200)}"`,
      );
      await this.reportRuntimeStatus(
        {
          state: "ERROR",
          phase: "exception",
          reply_in_progress: false,
          status_done_line: errorMessage,
        },
        replyTo,
      );
      const isExecutionFailure = this.isExecutionFailureLoopError(errorMessage);
      const loopState = isExecutionFailure
        ? this.evaluateErrorLoop(errorMessage)
        : {
            key: "non_execution_error",
            count: 1,
            open: false,
            suppressReport: false,
            cooldownMs: 0,
          };
      if (!isExecutionFailure) {
        this.resetErrorLoop();
      }
      const executionFailureLoop = isExecutionFailure && loopState.open;
      if (executionFailureLoop) {
        await this.reportRuntimeStatus(
          {
            state: "ERROR",
            phase: "execution_failure_loop",
            reply_in_progress: false,
            status_done_line: `${this.backendName} execution_failure_loop`,
          },
          replyTo,
        );
      }
      if (isExecutionFailure && loopState.suppressReport) {
        this.copilotLog(
          `suppress repeated error report key=${loopState.key} count=${loopState.count} cooldownMs=${loopState.cooldownMs}`,
        );
        return;
      }
      const reportMessage = executionFailureLoop
        ? `${this.backendName} 执行层失败循环(${loopState.key}, 连续${loopState.count}次): ${errorMessage}`
        : `${this.backendName} 处理失败: ${errorMessage}`;
      await this.reportError(reportMessage, replyTo);
    } finally {
      if (turnWatchdog) {
        clearInterval(turnWatchdog);
      }
      if (replyTo) {
        this.inFlightMessageIds.delete(replyTo);
      }
      this.copilotLog(
        `turn end replyTo=${replyTo || "latest"} elapsedMs=${Date.now() - turnStartedAt} processedIds=${this.processedMessageIds.size}`,
      );
      this.runningTurn = false;
    }
  }

  async handleSyntheticMessage(content, { includeImages }) {
    this.lastRuntimeStatusSignature = null;
    this.runningTurn = true;
    const startedAt = Date.now();
    if (
      this.useSessionFileReplyStream &&
      typeof this.backendSession?.setSessionReplyTarget === "function"
    ) {
      this.backendSession.setSessionReplyTarget("initial");
    }
    this.copilotLog(`synthetic turn start includeImages=${Boolean(includeImages)} contentLen=${String(content || "").length}`);
    try {
      const result = await this.backendSession.runTurn(content, {
        useInitialImages: includeImages,
        onProgress: (payload) => {
          void this.reportRuntimeStatus(payload, "initial");
        },
      });
      this.copilotLog(
        `synthetic runTurn completed elapsedMs=${Date.now() - startedAt} answerLen=${String(result.text || "").trim().length}`,
      );
      if (!this.useSessionFileReplyStream) {
        const backendLabel = this.backendName.charAt(0).toUpperCase() + this.backendName.slice(1);
        const intro = `${backendLabel} 已根据初始提示给出回复：`;
        const replyText =
          result.text || extractAgentTextFromItems(result.items) || extractAgentTextFromMetadata(result.metadata);
        const text = replyText ? `${intro}\n\n${replyText}` : intro;
        logBackendReply(this.backendName, replyText || "(无文本输出)", {
          usage: result.usage,
          replyTo: "initial",
        });
        await this.conductor.sendMessage(this.taskId, text, {
          model: this.backendSession.threadOptions?.model || this.backendName,
          backend: this.backendName,
          usage: result.usage || null,
          thread_id: this.backendSession.threadId,
          cli_args: this.cliArgs,
          synthetic: true,
        });
        this.copilotLog(`synthetic sdk_message sent responseLen=${text.length}`);
      } else {
        this.copilotLog("synthetic session_file turn settled");
      }
      await this.syncBackendSessionBinding();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.stopped && (this.remoteStopInfo || isSessionClosedError(error))) {
        this.copilotLog(`synthetic turn interrupted by stop_task elapsedMs=${Date.now() - startedAt}`);
        return;
      }
      if (await this.settleCodexCheckpointUnavailableAfterStream("initial", errorMessage, { markProcessed: false })) {
        return;
      }
      this.copilotLog(
        `synthetic turn failed elapsedMs=${Date.now() - startedAt} error="${sanitizeForLog(errorMessage, 200)}"`,
      );
      await this.reportError(`初始提示执行失败: ${errorMessage}`);
    } finally {
      this.copilotLog(`synthetic turn end elapsedMs=${Date.now() - startedAt}`);
      this.runningTurn = false;
    }
  }

  async reportError(message, replyTo) {
    try {
      await this.conductor.sendMessage(this.taskId, message, {
        severity: "error",
        backend: this.backendName,
        reply_to: replyTo,
        cli_args: this.cliArgs,
      });
    } catch (err) {
      log(`Failed to report error to Conductor: ${err.message}`);
    }
  }
}

function extractAgentTextFromItems(items) {
  if (!Array.isArray(items)) {
    return "";
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "";
}

function extractAgentTextFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return "";
  }
  const signals = metadata.signals;
  if (!signals || typeof signals !== "object") {
    return "";
  }
  if (typeof signals.replyText === "string" && signals.replyText.trim()) {
    return signals.replyText.trim();
  }
  if (Array.isArray(signals.replyBlocks)) {
    const merged = signals.replyBlocks
      .map((block) => (typeof block === "string" ? block.trim() : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (merged) {
      return merged;
    }
  }
  return "";
}

function log(message) {
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
  const line = `[${CLI_NAME} ${ts}] ${message}\n`;
  process.stdout.write(line);
  appendFireLocalLog(line);
}

function logBackendReply(backend, text, { usage, replyTo }) {
  const usageSuffix = usage?.total_tokens ? ` (tokens: ${usage.total_tokens})` : "";
  log(`${backend} reply (${replyTo}): ${text}${usageSuffix}`);
}

export function formatFatalError(error, opts = {}) {
  const showStack =
    typeof opts.showStack === "boolean"
      ? opts.showStack
      : isTruthyEnv(process.env.CONDUCTOR_CLI_SHOW_STACK) ||
        isTruthyEnv(process.env.CONDUCTOR_DEBUG);
  const message = error instanceof Error ? error.message : String(error);
  if (!showStack) {
    return message;
  }
  if (error instanceof Error && typeof error.stack === "string" && error.stack.trim()) {
    return error.stack;
  }
  return message;
}

function isDirectRun() {
  try {
    if (!process.argv[1]) {
      return false;
    }
    const argvPath = fs.realpathSync(process.argv[1]);
    const scriptPath = fs.realpathSync(__filename);
    return argvPath === scriptPath;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
    const line = `[${CLI_NAME} ${ts}] failed: ${formatFatalError(error)}\n`;
    process.stderr.write(line);
    appendFireLocalLog(line);
    process.exitCode = 1;
  });
}
