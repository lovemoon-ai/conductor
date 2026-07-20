#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import yaml from "js-yaml";

import { startDaemon } from "../src/daemon.js";
import {
  materializeConductorPathEnv,
  resolveConductorConfigPath,
  resolveConductorHome,
} from "../src/conductor-paths.js";

const argv = hideBin(process.argv);

const CLI_NAME = process.env.CONDUCTOR_CLI_NAME || "conductor-daemon";
const CONDUCTOR_HOME = resolveConductorHome();

function parseJsonArrayEnv(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((entry) => typeof entry === "string");
  } catch {
    return null;
  }
}

function stripNohupArgs(args) {
  return args.filter((arg) => !(arg === "--nohup" || arg.startsWith("--nohup=")));
}

function resolveLauncherConfig() {
  const inheritedLauncherScript =
    typeof process.env.CONDUCTOR_LAUNCHER_SCRIPT === "string" &&
    process.env.CONDUCTOR_LAUNCHER_SCRIPT.trim()
      ? process.env.CONDUCTOR_LAUNCHER_SCRIPT.trim()
      : null;
  const inheritedSubcommand =
    typeof process.env.CONDUCTOR_SUBCOMMAND === "string" &&
    process.env.CONDUCTOR_SUBCOMMAND.trim()
      ? process.env.CONDUCTOR_SUBCOMMAND.trim()
      : null;
  const inheritedSubcommandArgs = parseJsonArrayEnv(process.env.CONDUCTOR_SUBCOMMAND_ARGS_JSON);

  if (inheritedLauncherScript && inheritedSubcommand === "daemon" && inheritedSubcommandArgs) {
    return {
      RESTART_LAUNCHER_SCRIPT: inheritedLauncherScript,
      RESTART_LAUNCHER_ARGS: ["daemon", ...stripNohupArgs(inheritedSubcommandArgs)],
      VERSION_CHECK_SCRIPT: inheritedLauncherScript,
      VERSION_CHECK_ARGS: ["--version"],
    };
  }

  const daemonScript = path.resolve(process.argv[1]);
  return {
    RESTART_LAUNCHER_SCRIPT: daemonScript,
    RESTART_LAUNCHER_ARGS: argv,
    VERSION_CHECK_SCRIPT: inheritedLauncherScript,
    VERSION_CHECK_ARGS: ["--version"],
  };
}

function formatBeijingTimestampForFile(date = new Date()) {
  const base = date
    .toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false })
    .replace(" ", "T")
    .replace(/:/g, "-");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${base}-${millis}`;
}

function loadUserConfig(configFilePath) {
  try {
    const configPath = resolveConductorConfigPath(configFilePath);
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = yaml.load(content);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (_err) {
    // Ignore config parse errors here; daemon will surface them later.
  }
  return {};
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

function resolveWorkspaceRoot(configFilePath) {
  const userConfig = loadUserConfig(configFilePath);
  const home = process.env.HOME || os.homedir() || "/tmp";
  const workspaceRoot = process.env.CONDUCTOR_WS || userConfig.workspace || path.join(home, "ws");
  return expandHomePath(workspaceRoot, home);
}

function findRunningDaemonPid(workspaceRoot) {
  const lockFile = path.join(workspaceRoot, "daemon.pid");
  if (!fs.existsSync(lockFile)) {
    return null;
  }
  try {
    const pid = parseInt(fs.readFileSync(lockFile, "utf8"), 10);
    if (Number.isNaN(pid)) {
      return null;
    }
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    if (err && err.code === "ESRCH") {
      return null;
    }
    return pidFromLockFile(lockFile);
  }
}

function pidFromLockFile(lockFile) {
  try {
    const pid = parseInt(fs.readFileSync(lockFile, "utf8"), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch (_err) {
    return null;
  }
}

const args = yargs(argv)
  .scriptName(CLI_NAME)
  .usage("Usage: $0 [--clean-all] [--config-file <path>] [--nohup] [--force]")
  .option("nohup", {
    type: "boolean",
    default: false,
    describe: `Run in background and write logs to ${path.join(CONDUCTOR_HOME, "logs", "<timestamp>.log")}`,
  })
  .option("force", {
    type: "boolean",
    default: false,
    describe: "Force start by stopping an existing daemon process if needed",
  })
  .option("clean-all", {
    type: "boolean",
    default: false,
    describe: "Prune all stale daemon instances on backend before starting",
  })
  .option("config-file", {
    type: "string",
    describe: "Path to Conductor config file",
  })
  .example(`$0 --config-file ${resolveConductorConfigPath()}`, "Run with daemon_name from config")
  .example("$0 --nohup", "Run daemon in background with logfile")
  .example("$0 --nohup --force", "Restart daemon in background by stopping the existing one")
  .help()
  .strict()
  .parse();

const materializedConductorPathEnv = materializeConductorPathEnv(args.configFile);
Object.assign(process.env, materializedConductorPathEnv);
const effectiveConfigFile = args.configFile
  ? materializedConductorPathEnv.CONDUCTOR_CONFIG
  : undefined;

if (args.nohup) {
  const workspaceRoot = resolveWorkspaceRoot(effectiveConfigFile);
  const runningPid = findRunningDaemonPid(workspaceRoot);
  if (runningPid && !args.force) {
    process.stderr.write(
      `${CLI_NAME} detected an existing daemon (PID ${runningPid}). Use --force to restart.\n`,
    );
    process.exit(1);
  }

  const logsDir = path.join(resolveConductorHome(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const timestamp = formatBeijingTimestampForFile(new Date());
  const logPath = path.join(logsDir, `${timestamp}.log`);
  const filteredArgv = argv.filter((arg) => !(arg === "--nohup" || arg.startsWith("--nohup=")));
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [path.resolve(process.argv[1]), ...filteredArgv], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  process.stdout.write(`${CLI_NAME} running in background. Logs: ${logPath}\n`);
  process.exit(0);
}

startDaemon({
  CLEAN_ALL: args.cleanAll,
  CONFIG_FILE: effectiveConfigFile,
  FORCE: args.force,
  ...resolveLauncherConfig(),
});
