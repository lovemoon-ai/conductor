#!/usr/bin/env node

/**
 * conductor search — whole-history message search (the web GlobalSearch box).
 *
 * Usage:
 *   conductor search <query...> [--limit N]
 *
 * Route: GET /api/search?q=<query>&limit=<n>
 *   Response: { query, backend: "fts" | "like", hits: [{ taskId, taskTitle,
 *   messageId, role, snippet, createdAt }] }
 *
 * Human output groups hits by task (same as the web UI); `--json` prints the
 * raw response. Global flags: --json, --dry-run (accepted for consistency; a
 * search is read-only so it always runs), --config-file.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { EXIT, exitCodeForError, pad, printJson, printPretty, reportError } from "../src/entity-helpers.js";
import { apiPath, argsError, buildHttp } from "../src/backend-http.js";

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

/** Same default page size as the web search box. */
const DEFAULT_LIMIT = 30;

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function groupHitsByTask(hits) {
  const order = [];
  const byTask = new Map();
  for (const hit of hits) {
    let group = byTask.get(hit.taskId);
    if (!group) {
      group = { taskId: hit.taskId, taskTitle: hit.taskTitle, hits: [] };
      byTask.set(hit.taskId, group);
      order.push(hit.taskId);
    }
    group.hits.push(hit);
  }
  return order.map((taskId) => byTask.get(taskId));
}

async function handleSearch(argv, deps) {
  const query = [].concat(argv.query ?? []).map(String).join(" ").trim();
  if (!query) throw argsError("Search query must not be empty");
  if (argv.limit !== undefined && (!Number.isFinite(argv.limit) || argv.limit <= 0)) {
    throw argsError("--limit must be a positive number");
  }
  const http = await buildHttp(deps);
  const result = await http.get(apiPath("search"), {
    query: { q: query, limit: argv.limit ?? DEFAULT_LIMIT },
  });
  if (argv.json) {
    printJson(deps.stdout, result);
    return EXIT.OK;
  }
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  if (hits.length === 0) {
    printPretty(deps.stdout, `No messages match "${query}".`);
    return EXIT.OK;
  }
  const groups = groupHitsByTask(hits);
  printPretty(
    deps.stdout,
    `${hits.length} hit${hits.length === 1 ? "" : "s"} in ${groups.length} task${groups.length === 1 ? "" : "s"}`
      + (result?.backend ? ` (backend: ${result.backend})` : ""),
  );
  for (const group of groups) {
    printPretty(deps.stdout, "");
    printPretty(deps.stdout, `${group.taskTitle || "(untitled task)"}  [${group.taskId}]`);
    for (const hit of group.hits) {
      printPretty(
        deps.stdout,
        `  ${pad(formatTimestamp(hit.createdAt), 16)}  ${pad(hit.role ?? "", 9)}  ${oneLine(hit.snippet)}`,
      );
    }
  }
  return EXIT.OK;
}

export async function main(argvInput = hideBin(process.argv), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const consoleErr = { error: (msg) => stderr.write(`${msg}\n`) };
  const handlerDeps = { ...deps, stdout, stderr, env, cwd };

  let exitCode = EXIT.OK;
  try {
    await yargs(argvInput)
      .scriptName("conductor search")
      .strict()
      .help()
      .option("json", { type: "boolean", default: false })
      .option("dry-run", { type: "boolean", default: false, describe: "Accepted for consistency; search is read-only" })
      .option("config-file", { type: "string", describe: "Path to Conductor config file" })
      .command(
        "$0 <query..>",
        "Search message history across all of your tasks",
        (cmd) => cmd
          .positional("query", { type: "string", array: true, describe: "Search terms" })
          .option("limit", { type: "number", describe: `Maximum hits (default ${DEFAULT_LIMIT})` })
          .example("$0 flaky test", "Find messages mentioning 'flaky test'")
          .example("$0 migration --limit 5 --json", "Raw JSON, 5 hits"),
        async (argv) => {
          exitCode = await handleSearch(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .fail((msg, err) => {
        if (err) {
          throw err;
        }
        stderr.write(`${msg}\n`);
        exitCode = EXIT.ARGS;
      })
      .parseAsync();
  } catch (err) {
    exitCode = reportError(consoleErr, err);
  }
  return exitCode;
}

if (isMainModule) {
  main().then((code) => {
    if (code !== 0) process.exit(code);
  }).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(exitCodeForError(err));
  });
}
