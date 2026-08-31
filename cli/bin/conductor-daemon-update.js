#!/usr/bin/env node

/**
 * Internal entrypoint for the built-in "Update Daemon" action.
 *
 * The daemon spawns this file *detached* (see `createDaemonUpdateHandlers`) and
 * then forgets about it: the updater has to outlive the very daemon it is about
 * to replace. It is deliberately not registered as a `conductor` subcommand —
 * users update interactively with `conductor update`.
 *
 * Usage: node bin/conductor-daemon-update.js '<params-json>'
 */

import process from "node:process";

import { runDaemonUpdate, writeDaemonUpdateStatus } from "../src/daemon-update.js";

const raw = process.argv[2];
if (!raw) {
  process.stderr.write("conductor-daemon-update: missing params JSON argument\n");
  process.exit(2);
}

let params;
try {
  params = JSON.parse(raw);
} catch (error) {
  process.stderr.write(`conductor-daemon-update: invalid params JSON: ${error?.message || error}\n`);
  process.exit(2);
}

let result;
try {
  result = await runDaemonUpdate(params, {
    writeLine: (line) => process.stdout.write(`[${new Date().toISOString()}] ${line}\n`),
  });
} catch (error) {
  // The status file is how the UI learns the outcome; an unexpected crash here
  // must not leave it stuck on "running" forever.
  const message = error?.stack || error?.message || String(error);
  process.stderr.write(`conductor-daemon-update: ${message}\n`);
  writeDaemonUpdateStatus(params.statusPath, {
    runId: params.runId ?? null,
    status: "failed",
    phase: "done",
    message: "Update failed",
    error: message,
    logPath: params.logPath ?? null,
    daemonRestarted: false,
    finishedAt: new Date().toISOString(),
  });
  process.exit(1);
}

process.exit(result.status === "completed" ? 0 : 1);
