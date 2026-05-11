#!/usr/bin/env node

/**
 * conductor task — entity-oriented task management.
 *
 * Subcommands:
 *   list [--project ...] [--issue <id>] [--status ...]
 *   show <id>
 *   send <id> [<message>] [--stdin] [--from-file FILE] [--metadata-json '{...}']
 *   messages <id> [--limit N] [--before <msg-id>]
 *
 * Global flags supported on every write subcommand:
 *   --json, --dry-run, --project, --config-file
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import {
  EXIT,
  buildApis,
  buildAuditMetadata,
  emitDryRun,
  exitCodeForError,
  makeDryRunPayload,
  pad,
  printJson,
  printPretty,
  readMessageInput,
  reportError,
  resolveProject,
} from "../src/entity-helpers.js";

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

function buildBaseUrl(config) {
  const raw = (config?.backendUrl || "").replace(/\/+$/, "");
  return raw || "http://localhost";
}

function taskAsObject(task) {
  if (!task) return null;
  if (typeof task.asObject === "function") return task.asObject();
  return {
    id: task.id,
    projectId: task.projectId,
    issueId: task.issueId ?? null,
    title: task.title,
    status: task.status,
    backendType: task.backendType,
    sessionId: task.sessionId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function parseStatusList(value) {
  if (!value) return undefined;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseMetadataJson(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed;
  } catch (err) {
    const e = new Error(`Invalid --metadata-json: ${err instanceof Error ? err.message : String(err)}`);
    e.code = "ARGS";
    throw e;
  }
}

async function handleList(argv, deps) {
  const apis = await buildApis(deps);
  const project = await resolveProject(apis, { env: deps.env, cwd: deps.cwd, project: argv.project });
  const list = await apis.tasks.listTasks({
    projectId: project.id,
    issueId: argv.issue ? String(argv.issue) : undefined,
    status: parseStatusList(argv.status),
  });
  const objects = (Array.isArray(list) ? list : []).map(taskAsObject);
  if (argv.json) {
    printJson(deps.stdout, objects);
    return EXIT.OK;
  }
  if (objects.length === 0) {
    printPretty(deps.stdout, "(no tasks)");
    return EXIT.OK;
  }
  printPretty(deps.stdout, `${pad("ID", 24)} ${pad("STATUS", 12)} TITLE`);
  for (const task of objects) {
    printPretty(
      deps.stdout,
      `${pad(task.id, 24)} ${pad(task.status, 12)} ${task.title ?? ""}`,
    );
  }
  return EXIT.OK;
}

async function handleShow(argv, deps) {
  const apis = await buildApis(deps);
  const task = await apis.tasks.getTask(argv.id);
  if (!task) {
    const err = new Error(`Task not found: ${argv.id}`);
    err.statusCode = 404;
    throw err;
  }
  const obj = taskAsObject(task);
  if (argv.json) {
    printJson(deps.stdout, obj);
    return EXIT.OK;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      printPretty(deps.stdout, `${key}: ${JSON.stringify(value)}`);
    } else {
      printPretty(deps.stdout, `${key}: ${value}`);
    }
  }
  return EXIT.OK;
}

async function handleSend(argv, deps) {
  const apis = await buildApis(deps);
  const content = readMessageInput({
    positional: argv.message,
    fromFile: argv.fromFile,
    useStdin: Boolean(argv.stdin),
    stdin: deps.stdin,
  });
  const extraMetadata = parseMetadataJson(argv.metadataJson);
  // `buildAuditMetadata(env, extra)` namespaces `audit.*` so that user-supplied
  // `--metadata-json '{"actor":"system"}'` cannot spoof CLI audit fields
  // (review H1). The CLI's `actor: "cli"` always wins inside `audit`.
  const metadata = buildAuditMetadata(deps.env, extraMetadata || {});
  const body = {
    role: "user",
    content,
    metadata,
  };
  if (argv.dryRun) {
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload(
        "POST",
        `${buildBaseUrl(apis.config)}/api/tasks/${encodeURIComponent(argv.id)}/messages`,
        body,
      ),
    );
    return EXIT.OK;
  }
  // SDK signature is `sendTaskMessage(taskId, content, options?)`. Earlier we
  // were passing the body object as the second arg, which caused the SDK's
  // `typeof content === 'string'` guard to throw at runtime (review B1).
  const result = await apis.tasks.sendTaskMessage(argv.id, content, {
    role: body.role,
    metadata: body.metadata,
  });
  if (argv.json) {
    printJson(deps.stdout, result ?? { sent: true });
    return EXIT.OK;
  }
  const id = result?.id ? `${result.id} ` : "";
  printPretty(deps.stdout, `Sent message ${id}to task ${argv.id}`);
  return EXIT.OK;
}

async function handleMessages(argv, deps) {
  const apis = await buildApis(deps);
  const list = await apis.tasks.listTaskMessages(argv.id, {
    limit: argv.limit ? Number(argv.limit) : undefined,
    before: argv.before ? String(argv.before) : undefined,
  });
  if (argv.json) {
    printJson(deps.stdout, Array.isArray(list) ? list : []);
    return EXIT.OK;
  }
  for (const msg of Array.isArray(list) ? list : []) {
    const role = msg.role || "msg";
    const content = (msg.content || "").toString();
    printPretty(deps.stdout, `[${role}] ${content}`);
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
      .scriptName("conductor task")
      .strict()
      .help()
      .option("json", { type: "boolean", default: false })
      .option("dry-run", { type: "boolean", default: false })
      .option("project", { type: "string", describe: "Project id or name override" })
      .option("config-file", { type: "string", describe: "Path to Conductor config file" })
      .command(
        "list",
        "List tasks in a project",
        (cmd) => cmd
          .option("issue", { type: "string", describe: "Filter by linked issue id" })
          .option("status", { type: "string", describe: "Comma-separated status filter" }),
        async (argv) => {
          exitCode = await handleList(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "show <id>",
        "Show one task's detail",
        (cmd) => cmd.positional("id", { type: "string", demandOption: true }),
        async (argv) => {
          exitCode = await handleShow(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "send <id> [message]",
        "Send a user message into a running task",
        (cmd) => cmd
          .positional("id", { type: "string", demandOption: true })
          .positional("message", { type: "string" })
          .option("stdin", { type: "boolean", default: false })
          .option("from-file", { type: "string" })
          .option("metadata-json", { type: "string", describe: "Extra JSON metadata to merge into the message" }),
        async (argv) => {
          exitCode = await handleSend(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "messages <id>",
        "Pull a slice of task messages and exit (no --follow in this RFC)",
        (cmd) => cmd
          .positional("id", { type: "string", demandOption: true })
          .option("limit", { type: "number" })
          .option("before", { type: "string", describe: "Cursor: message id to paginate before" }),
        async (argv) => {
          exitCode = await handleMessages(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .demandCommand(1)
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
