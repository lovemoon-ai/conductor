/**
 * `conductor remote wait` — pick up a command started by `remote exec` that
 * outlived its deadline (or the process that started it).
 *
 * `exec` prints the run id whenever it leaves a command behind; this verb
 * polls that run the same way `exec` would have and reports it identically,
 * so a caller can always finish what it started.
 */

import process from "node:process";

import { EXIT, callApi, delay, loadCliConfig } from "./client.js";
import {
  interruptSignal,
  parseArgs,
  parseTimeoutMs,
  reportRun,
  waitForRun,
} from "./exec.js";

export function showHelp(consoleImpl = console) {
  consoleImpl.log(`conductor remote wait - wait for a command left running by \`remote exec\`

Usage:
  conductor remote wait --target <daemon> [options] <runId>

Options:
  -t, --target <daemon>   Daemon the command is running on (required)
      --timeout <dur>     How long to wait this time, e.g. 30s, 2m (default: 60s)
      --json              Print the raw run result as JSON
      --kill-on-timeout   Stop the remote command when --timeout is reached or
                          this CLI is interrupted (default: it keeps running)
      --config-file <p>   Conductor config file to authenticate with
  -h, --help              Show this help

Output and exit codes match \`conductor remote exec\`: the command's own exit
code is passed through, 255 means this CLI failed or the command is still running.

Example:
  conductor remote exec -t ubuntu --timeout 30s -- make build
  # ... [conductor] still running on ubuntu after 30000ms; resume with:
  conductor remote wait -t ubuntu --timeout 20m 3f9c1b2e-...
`);
}

export async function runRemoteWait(argv, deps = {}) {
  const consoleImpl = deps.console || console;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const env = deps.env || process.env;
  const sleep = deps.sleep || delay;
  const now = deps.now || (() => Date.now());

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }
  const { options, command } = parsed;

  if (options.help) {
    showHelp(consoleImpl);
    return EXIT.OK;
  }

  const target = typeof options.target === "string" ? options.target.trim() : "";
  if (!target) {
    consoleImpl.error("Error: --target <daemon> is required");
    showHelp(consoleImpl);
    return EXIT.CLI_ERROR;
  }
  if (command.length !== 1) {
    consoleImpl.error(command.length === 0 ? "Error: no runId given" : "Error: expected exactly one runId");
    showHelp(consoleImpl);
    return EXIT.CLI_ERROR;
  }
  const runId = command[0];

  let timeoutMs;
  try {
    timeoutMs = parseTimeoutMs(options.timeout);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }

  let config;
  try {
    config = deps.config || loadCliConfig(options.configFile, env);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }

  const basePath = `/api/agents/${encodeURIComponent(target)}/exec`;
  const interrupt = interruptSignal(deps.process);
  let run;
  let pollError = null;
  try {
    const deadline = now() + timeoutMs;
    run = await callApi(config, "GET", `${basePath}/runs/${encodeURIComponent(runId)}`, null, fetchImpl);
    let killError;
    ({ run, pollError, killError } = await waitForRun(config, basePath, run, {
      deadline,
      fetchImpl,
      sleep,
      now,
      killOnTimeout: options.killOnTimeout,
      signal: interrupt.signal,
    }));
    if (killError) {
      consoleImpl.error(`[conductor] failed to stop the run on ${target}: ${killError.message}`);
    } else if (options.killOnTimeout && run?.status === "cancelled") {
      const why = interrupt.signal.aborted ? "interrupted" : "deadline reached";
      consoleImpl.error(`[conductor] ${why}; stopped the command on ${target}`);
    }
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  } finally {
    interrupt.release();
  }

  return reportRun(run, {
    consoleImpl,
    json: options.json,
    target,
    pollError,
    waitedMs: timeoutMs,
    interrupted: interrupt.signal.aborted,
  });
}
