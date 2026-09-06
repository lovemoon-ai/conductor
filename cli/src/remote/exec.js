/**
 * `conductor remote exec` — run one command on another daemon's host.
 *
 * The command is sent as argv and spawned without a shell on the target, so
 * quoting is not re-interpreted remotely. Pass `-- bash -lc "..."` when pipes
 * or globs are actually wanted.
 */

import process from "node:process";

import {
  EXIT,
  UsageError,
  callApi,
  delay,
  loadCliConfig,
  parseTimeoutMs as parseSharedTimeoutMs,
} from "./client.js";

export { EXIT, UsageError };

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
/** How long a single request may block server-side before we switch to polling. */
const POST_WAIT_MS = 10_000;

const VALUE_FLAGS = new Map([
  ["--target", "target"],
  ["-t", "target"],
  ["--workspace", "workspace"],
  ["-w", "workspace"],
  ["--timeout", "timeout"],
  ["--config-file", "configFile"],
  ["--env", "env"],
  ["-e", "env"],
]);

const BOOL_FLAGS = new Map([
  ["--json", "json"],
  ["--kill-on-timeout", "killOnTimeout"],
  ["--help", "help"],
  ["-h", "help"],
]);

/**
 * Split argv into flags and the remote command.
 *
 * Both `... --workspace /p ls .` and `... --workspace /p -- ls .` are accepted:
 * the first token that is not a recognized flag starts the remote command, and
 * everything after it is passed through verbatim.
 */
export function parseArgs(argv) {
  const options = { env: {}, json: false, help: false };
  const command = [];

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];

    if (token === "--") {
      command.push(...argv.slice(index + 1));
      break;
    }

    let name = token;
    let inlineValue = null;
    if (token.startsWith("--") && token.includes("=")) {
      const splitAt = token.indexOf("=");
      name = token.slice(0, splitAt);
      inlineValue = token.slice(splitAt + 1);
    }

    if (BOOL_FLAGS.has(name) && inlineValue === null) {
      options[BOOL_FLAGS.get(name)] = true;
      index += 1;
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      const key = VALUE_FLAGS.get(name);
      const value = inlineValue !== null ? inlineValue : argv[index + 1];
      if (value === undefined) {
        throw new UsageError(`${name} requires a value`);
      }
      if (key === "env") {
        const splitAt = value.indexOf("=");
        if (splitAt <= 0) {
          throw new UsageError(`--env expects KEY=VALUE, got: ${value}`);
        }
        options.env[value.slice(0, splitAt)] = value.slice(splitAt + 1);
      } else {
        options[key] = value;
      }
      index += inlineValue !== null ? 1 : 2;
      continue;
    }

    command.push(...argv.slice(index));
    break;
  }

  return { options, command };
}

/** Accepts `500ms`, `30s`, `2m`, or a bare number of seconds. */
export function parseTimeoutMs(value) {
  return parseSharedTimeoutMs(value, DEFAULT_TIMEOUT_MS);
}

export function showHelp(consoleImpl = console) {
  consoleImpl.log(`conductor remote exec - run a command on another daemon's host

Usage:
  conductor remote exec --target <daemon> [options] <command> [args...]
  conductor remote exec --target <daemon> [options] -- <command> [args...]

Options:
  -t, --target <daemon>   Daemon name to run on (required)
  -w, --workspace <path>  Working directory on the target (default: target's home)
      --timeout <dur>     Overall deadline, e.g. 30s, 2m, 500ms (default: 60s)
  -e, --env KEY=VALUE     Extra environment variable (repeatable)
      --json              Print the raw run result as JSON
      --kill-on-timeout   Stop the remote command when --timeout is reached
                          (default: it keeps running on the target)
      --config-file <p>   Conductor config file to authenticate with
  -h, --help              Show this help

Notes:
  The command is spawned without a shell. For pipes, globs or redirection use:
    conductor remote exec -t ubuntu -- bash -lc "ls | wc -l"

  Exit codes follow ssh: the remote command's own code is passed through, and
  255 means this CLI failed (bad usage, daemon offline, network error).

Examples:
  conductor remote exec --target ubuntu --workspace /home/duino/ws/holomotion ls .
  conductor remote exec -t ubuntu -w /srv/app -- git log --oneline -5
`);
}

/**
 * Run one command on `target` and return the final run record.
 *
 * This is the programmatic half of `runRemoteExec`: same two-phase POST-then-poll
 * behaviour, no argv parsing and no printing. `remote cp -r` uses it to drive
 * `tar` on the target.
 */
export async function execRemote(config, target, command, options = {}) {
  const {
    args = [],
    workspace,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    sleep = delay,
    now = () => Date.now(),
    killOnTimeout = false,
  } = options;

  const basePath = `/api/agents/${encodeURIComponent(target)}/exec`;
  const deadline = now() + timeoutMs;

  let run = await callApi(config, "POST", basePath, {
    command,
    args,
    ...(workspace ? { workspace } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    // Deliberately short, and independent of the overall deadline: that is
    // owned by the poll loop below. Handing the daemon the full budget would
    // make one HTTP request block for it and leave the loop unreachable.
    timeoutMs: Math.min(timeoutMs, POST_WAIT_MS),
  }, fetchImpl);

  let pollError = null;
  while (run?.status === "running" && now() < deadline) {
    if (!run.runId) {
      pollError = new Error("daemon reported a running command but returned no runId");
      break;
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      run = await callApi(
        config,
        "GET",
        `${basePath}/runs/${encodeURIComponent(run.runId)}`,
        null,
        fetchImpl,
      );
      pollError = null;
    } catch (error) {
      // A saturated or briefly unreachable daemon can fail one status poll.
      // Keep waiting until the caller's own deadline rather than aborting a
      // long-running command that is still perfectly healthy.
      pollError = error;
    }
  }

  let killError = null;
  if (run?.status === "running" && killOnTimeout && run.runId) {
    try {
      run = await callApi(
        config,
        "DELETE",
        `${basePath}/runs/${encodeURIComponent(run.runId)}`,
        null,
        fetchImpl,
      );
    } catch (error) {
      // Failing to stop it must not cost the caller the output we already have.
      killError = error;
    }
  }

  return { run, pollError, killError, basePath };
}

/**
 * `execRemote` for callers that only care whether it worked. Throws with the
 * remote's own stderr, which is what the user needs to see.
 */
export async function execRemoteOrThrow(config, target, command, options = {}) {
  const { run } = await execRemote(config, target, command, options);
  if (run?.status === "completed" && run.exitCode === 0) return run;

  const detail = (run?.stderrTail || run?.stdoutTail || run?.error || "").trim();
  const what = run?.status === "running"
    ? `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
    : `exited ${run?.exitCode ?? "?"}`;
  throw new Error(detail ? `${what} on ${target}: ${detail}` : `${what} on ${target}`);
}

export async function runRemoteExec(argv, deps = {}) {
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
  if (command.length === 0) {
    consoleImpl.error("Error: no command given");
    showHelp(consoleImpl);
    return EXIT.CLI_ERROR;
  }

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

  let run;
  let pollError = null;
  let basePath;
  try {
    let killError;
    ({ run, pollError, killError, basePath } = await execRemote(config, target, command[0], {
      args: command.slice(1),
      workspace: options.workspace,
      env: options.env,
      timeoutMs,
      fetchImpl,
      sleep,
      now,
      killOnTimeout: options.killOnTimeout,
    }));
    if (killError) {
      consoleImpl.error(`[conductor] failed to stop the run on ${target}: ${killError.message}`);
    } else if (options.killOnTimeout && run?.status === "cancelled") {
      consoleImpl.error(`[conductor] deadline reached; stopped the command on ${target}`);
    }
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }

  if (options.json) {
    consoleImpl.log(JSON.stringify(run, null, 2));
  } else {
    if (run?.stdoutTail) process.stdout.write(run.stdoutTail);
    if (run?.stderrTail) process.stderr.write(run.stderrTail);
    if (run?.truncated) {
      consoleImpl.error(`[conductor] output truncated; showing the tail only`);
    }
    if (run?.error) {
      consoleImpl.error(`Error: ${run.error}`);
    }
  }

  if (run?.status === "running") {
    if (pollError) {
      consoleImpl.error(`[conductor] last status poll failed: ${pollError.message}`);
    }
    consoleImpl.error(
      `[conductor] still running on ${target} after ${timeoutMs}ms; ` +
        `it keeps going there — poll GET ${basePath}/runs/${run.runId}, ` +
        `stop it with DELETE on the same path, or use --kill-on-timeout`,
    );
    return EXIT.CLI_ERROR;
  }
  if (run?.status === "cancelled") {
    return EXIT.CLI_ERROR;
  }
  if (typeof run?.exitCode === "number") {
    return run.exitCode;
  }
  return run?.status === "completed" ? EXIT.OK : EXIT.CLI_ERROR;
}
