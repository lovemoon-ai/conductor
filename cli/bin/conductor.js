#!/usr/bin/env node

/**
 * conductor - Main CLI entry point with subcommand routing.
 *
 * Subcommands:
 *   fire     - Run AI coding agents with Conductor integration
 *   daemon   - Start long-running daemon for task orchestration
 *   config   - Interactive configuration setup
 *   update   - Update the CLI to the latest version
 *   diagnose - Diagnose a task in production/backend
 *   send-file - Upload a local file into a task session
 *   channel  - Connect user-owned chat channel providers
 *   serve-ai - Start an OpenAI-compatible local AI server
 *   project  - Manage Conductor projects (list/show/create/...)
 *   issue    - Manage issues (list/show/create/update/start/done)
 *   task     - Manage tasks (list/show/send/messages/schedule)
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { maybeCheckForUpdates } from "../src/cli-update-notifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.join(__dirname, "..");

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));

// Parse command line arguments
const argv = process.argv.slice(2);

export function runConductorCli(args = argv, deps = {}) {
  const consoleImpl = deps.console || console;
  const importModule = deps.importModule || ((subcommandPath) => import(subcommandPath));
  const env = deps.env || process.env;
  const processArgv = deps.processArgv || process.argv;
  const fsExistsSync = deps.existsSync || fs.existsSync;
  const checkForUpdates = deps.maybeCheckForUpdates || maybeCheckForUpdates;
  const validSubcommands = [
    "fire",
    "daemon",
    "config",
    "update",
    "diagnose",
    "send-file",
    "channel",
    "serve-ai",
    "project",
    "issue",
    "task",
  ];

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    showHelp(consoleImpl);
    return { shouldExit: true, exitCode: 0 };
  }

  if (args[0] === "--version" || args[0] === "-v") {
    const commitId = pkgJson.gitCommitId || "unknown";
    consoleImpl.log(`conductor version ${pkgJson.version} (${commitId})`);
    return { shouldExit: true, exitCode: 0 };
  }

  const subcommand = args[0];
  if (!validSubcommands.includes(subcommand)) {
    consoleImpl.error(`Error: Unknown subcommand '${subcommand}'`);
    consoleImpl.error(`Valid subcommands: ${validSubcommands.join(", ")}`);
    consoleImpl.error(`Run 'conductor --help' for usage information.`);
    return { shouldExit: true, exitCode: 1 };
  }

  void checkForUpdates({
    currentVersion: pkgJson.version,
    subcommand,
    env,
  }).catch(() => {});

  const subcommandArgs = args.slice(1);
  env.CONDUCTOR_CLI_NAME = `conductor ${subcommand}`;
  env.CONDUCTOR_LAUNCHER_SCRIPT = processArgv[1] || "";
  env.CONDUCTOR_SUBCOMMAND = subcommand;
  env.CONDUCTOR_SUBCOMMAND_ARGS_JSON = JSON.stringify(subcommandArgs);

  const subcommandPath = path.join(__dirname, `conductor-${subcommand}.js`);
  if (!fsExistsSync(subcommandPath)) {
    consoleImpl.error(`Error: Subcommand implementation not found: ${subcommandPath}`);
    return { shouldExit: true, exitCode: 1 };
  }

  process.argv = [processArgv[0], subcommandPath, ...subcommandArgs];
  importModule(subcommandPath).catch((error) => {
    consoleImpl.error(`Error loading subcommand '${subcommand}': ${error.message}`);
    process.exit(1);
  });
  return { shouldExit: false, exitCode: 0 };
}

const isDirectExecution = (() => {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  try {
    const entryRealPath = fs.realpathSync(entryPath);
    const currentRealPath = fs.realpathSync(__filename);
    return pathToFileURL(entryRealPath).href === pathToFileURL(currentRealPath).href;
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  const result = runConductorCli();
  if (result.shouldExit) {
    process.exit(result.exitCode);
  }
}

function showHelp(consoleImpl = console) {
  consoleImpl.log(`conductor - Conductor CLI tool

Usage: conductor <subcommand> [options]

Subcommands:
  fire      Run AI coding agents with Conductor integration
  daemon    Start long-running daemon for task orchestration
  config    Interactive configuration setup
  update    Update the CLI to the latest version
  diagnose  Diagnose a task and print likely root cause
  send-file Upload a local file into a task session
  channel   Connect user-owned chat channel providers
  serve-ai  Start an OpenAI-compatible local AI server
  project   Manage Conductor projects (list/show/create/...)
  issue     Manage issues (list/show/create/update/start/done)
  task      Manage tasks (list/show/send/messages/schedule)

Options:
  -h, --help     Show this help message
  -v, --version  Show version information

Environment:
  CONDUCTOR_HOME    User data directory (default: ~/.conductor)
  CONDUCTOR_CONFIG  Config file override (takes precedence over CONDUCTOR_HOME)

Examples:
  conductor fire -- "fix the bug"
  conductor fire --backend claude -- "add feature"
  conductor daemon --config-file ~/.conductor/config.yaml
  conductor diagnose <task-id>
  conductor send-file ./screenshot.png
  conductor channel connect feishu
  conductor serve-ai --port 8787
  conductor config
  conductor update
  conductor project list
  conductor issue create --title "Refactor module" --priority P2
  conductor task send <task-id> "please add a unit test"
  conductor task schedule create <task-id> "follow up" --delay 10m

For subcommand-specific help:
  conductor fire --help
  conductor daemon --help
  conductor config --help
  conductor update --help
  conductor diagnose --help
  conductor send-file --help
  conductor channel --help
  conductor serve-ai --help
  conductor project --help
  conductor issue --help
  conductor task --help

Version: ${pkgJson.version}
`);
}
