#!/usr/bin/env node

/**
 * conductor remote — act on another daemon's host.
 *
 *   conductor remote exec --target ubuntu -- bash -lc "pnpm build 2>&1 | tail -20"
 *   conductor remote cp ./build.tar.gz ubuntu:/srv/app/build.tar.gz
 *   conductor remote cp ubuntu:/var/log/conductor.log ./conductor.log
 *
 * Verb dispatch is hand-rolled rather than delegated to yargs on purpose:
 * `exec` has to hand an arbitrary remote argv through untouched, and yargs'
 * `strict()` would try to interpret the remote command's own flags.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { EXIT } from "../src/remote/client.js";
import { runRemoteExec, showHelp as showExecHelp } from "../src/remote/exec.js";
import { runRemoteCp, showHelp as showCpHelp } from "../src/remote/cp.js";
import { runRemoteWait, showHelp as showWaitHelp } from "../src/remote/wait.js";

export { EXIT };

const VERBS = new Map([
  ["exec", runRemoteExec],
  ["cp", runRemoteCp],
  ["wait", runRemoteWait],
]);

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

export function showHelp(consoleImpl = console) {
  consoleImpl.log(`conductor remote - act on another daemon's host

Usage:
  conductor remote <verb> [options]

Verbs:
  exec   Run a command on another daemon's host
  cp     Copy a file to or from another daemon's host
  wait   Wait for a command that \`exec\` left running (by run id)

Options:
  -h, --help   Show this help

Examples:
  conductor remote exec --target ubuntu --workspace /srv/app -- git log --oneline -5
  conductor remote cp ./build.tar.gz ubuntu:/srv/app/build.tar.gz
  conductor remote cp ubuntu:/var/log/conductor.log ./conductor.log
  conductor remote wait --target ubuntu <runId>

For verb-specific help:
  conductor remote exec --help
  conductor remote cp --help
  conductor remote wait --help
`);
}

export async function runRemote(argv, deps = {}) {
  const consoleImpl = deps.console || console;

  if (argv.length === 0) {
    showHelp(consoleImpl);
    return EXIT.CLI_ERROR;
  }

  const verb = argv[0];
  if (verb === "--help" || verb === "-h") {
    showHelp(consoleImpl);
    return EXIT.OK;
  }

  const handler = VERBS.get(verb);
  if (!handler) {
    // `--help` on a verb belongs to the verb, but a bare flag in the verb slot
    // is a usage mistake worth naming precisely.
    consoleImpl.error(`Error: unknown verb '${verb}'`);
    consoleImpl.error(`Valid verbs: ${[...VERBS.keys()].join(", ")}`);
    showHelp(consoleImpl);
    return EXIT.CLI_ERROR;
  }

  return handler(argv.slice(1), deps);
}

export { showExecHelp, showCpHelp, showWaitHelp };

if (isMainModule) {
  // `process.exitCode` rather than `process.exit()`: writes to a pipe are async,
  // and exiting outright truncates them. Let the loop drain and end naturally.
  process.exitCode = await runRemote(process.argv.slice(2));
}
