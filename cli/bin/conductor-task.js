#!/usr/bin/env node

/**
 * conductor task — entity-oriented task management.
 *
 * Subcommands:
 *   list [--project ...] [--issue <id>] [--status ...]
 *   show <id>
 *   send <id> [<message>] [--stdin] [--from-file FILE] [--metadata-json '{...}']
 *   insert <id> [<message>] [--stdin] [--from-file FILE] [--target-reply-to <msg-id>]
 *   messages <id> [--limit N] [--before <msg-id>]
 *   schedule list <id>
 *   schedule create <id> [<message>] (--delay 10m | --at ISO | --every 1h)
 *   schedule delete <id> <schedule-id>
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

function parseDuration(value, label) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (!match) {
    const err = new Error(`${label} must look like 10m, 2h, 10 minutes, or 2 hours`);
    err.code = "ARGS";
    throw err;
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    const err = new Error(`${label} must be a positive duration`);
    err.code = "ARGS";
    throw err;
  }
  return {
    amount,
    unit: match[2].startsWith("h") ? "hour" : "minute",
  };
}

function parseFutureIso(value, label) {
  const raw = String(value ?? "").trim();
  const date = new Date(raw);
  if (!raw || !Number.isFinite(date.getTime())) {
    const err = new Error(`${label} must be a valid date/time string`);
    err.code = "ARGS";
    throw err;
  }
  return date.toISOString();
}

function parsePositiveIntegerOption(value, label) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err = new Error(`${label} must be a positive integer`);
    err.code = "ARGS";
    throw err;
  }
  return parsed;
}

function parseScheduleOptions(argv) {
  const modes = [
    argv.delay !== undefined ? "delay" : null,
    argv.at !== undefined ? "at" : null,
    argv.every !== undefined ? "every" : null,
  ].filter(Boolean);
  if (modes.length !== 1) {
    const err = new Error("Provide exactly one schedule mode: --delay, --at, or --every");
    err.code = "ARGS";
    throw err;
  }

  if (argv.delay !== undefined) {
    const parsed = parseDuration(argv.delay, "--delay");
    return {
      mode: "delay",
      amount: parsed.amount,
      unit: parsed.unit,
    };
  }

  if (argv.at !== undefined) {
    return {
      mode: "at",
      sendAt: parseFutureIso(argv.at, "--at"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  const parsed = parseDuration(argv.every, "--every");
  const stop = {
    stopWhenTaskNotRunning: !argv.keepWhenTaskStopped,
  };
  const maxRuns = parsePositiveIntegerOption(argv.maxRuns, "--max-runs");
  const maxSkips = parsePositiveIntegerOption(argv.maxSkips, "--max-skips");
  if (maxRuns !== undefined) {
    stop.maxRuns = maxRuns;
  }
  if (maxSkips !== undefined) {
    stop.maxSkips = maxSkips;
  }
  if (argv.stopAt !== undefined) {
    stop.stopAt = parseFutureIso(argv.stopAt, "--stop-at");
  }

  return {
    mode: "interval",
    every: parsed.amount,
    unit: parsed.unit,
    condition: argv.ifIdle ? "ai_idle" : "none",
    stop,
  };
}

function scheduledMessageAsObject(schedule) {
  if (!schedule) return null;
  if (typeof schedule.asObject === "function") return schedule.asObject();
  return {
    id: schedule.id,
    taskId: schedule.taskId ?? schedule.task_id,
    sourceMessageId: schedule.sourceMessageId ?? schedule.source_message_id ?? null,
    content: schedule.content,
    kind: schedule.kind,
    condition: schedule.condition,
    status: schedule.status,
    nextRunAt: schedule.nextRunAt ?? schedule.next_run_at,
    runCount: schedule.runCount ?? schedule.run_count ?? 0,
    skipCount: schedule.skipCount ?? schedule.skip_count ?? 0,
    failureCount: schedule.failureCount ?? schedule.failure_count ?? 0,
    maxRuns: schedule.maxRuns ?? schedule.max_runs ?? null,
    maxSkips: schedule.maxSkips ?? schedule.max_skips ?? null,
    stopAt: schedule.stopAt ?? schedule.stop_at ?? null,
    lastRunAt: schedule.lastRunAt ?? schedule.last_run_at ?? null,
    lastError: schedule.lastError ?? schedule.last_error ?? null,
    createdAt: schedule.createdAt ?? schedule.created_at ?? null,
    updatedAt: schedule.updatedAt ?? schedule.updated_at ?? null,
  };
}

function formatContentPreview(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= 60) return text;
  return `${text.slice(0, 57)}...`;
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

async function handleInsert(argv, deps) {
  const apis = await buildApis(deps);
  const content = readMessageInput({
    positional: argv.message,
    fromFile: argv.fromFile,
    useStdin: Boolean(argv.stdin),
    stdin: deps.stdin,
  });
  const extraMetadata = parseMetadataJson(argv.metadataJson);
  const metadata = buildAuditMetadata(deps.env, extraMetadata || {});
  const body = {
    content,
    metadata,
  };
  if (argv.targetReplyTo) {
    body.target_reply_to = String(argv.targetReplyTo);
  }
  if (argv.dryRun) {
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload(
        "POST",
        `${buildBaseUrl(apis.config)}/api/tasks/${encodeURIComponent(argv.id)}/insert`,
        body,
      ),
    );
    return EXIT.OK;
  }
  const result = await apis.tasks.insertTaskMessage(argv.id, content, {
    metadata: body.metadata,
    targetReplyTo: argv.targetReplyTo ? String(argv.targetReplyTo) : undefined,
  });
  if (argv.json) {
    printJson(deps.stdout, result ?? { inserted: true });
    return EXIT.OK;
  }
  const id = result?.id ? `${result.id} ` : "";
  printPretty(deps.stdout, `Inserted message ${id}into task ${argv.id}`);
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

async function handleScheduleList(argv, deps) {
  const apis = await buildApis(deps);
  const schedules = await apis.tasks.listScheduledMessages(argv.id);
  const objects = (Array.isArray(schedules) ? schedules : []).map(scheduledMessageAsObject);
  if (argv.json) {
    printJson(deps.stdout, objects);
    return EXIT.OK;
  }
  if (objects.length === 0) {
    printPretty(deps.stdout, "(no scheduled messages)");
    return EXIT.OK;
  }
  printPretty(deps.stdout, `${pad("ID", 24)} ${pad("STATUS", 10)} ${pad("NEXT RUN", 24)} CONTENT`);
  for (const schedule of objects) {
    printPretty(
      deps.stdout,
      `${pad(schedule.id, 24)} ${pad(schedule.status, 10)} ${pad(schedule.nextRunAt, 24)} ${formatContentPreview(schedule.content)}`,
    );
  }
  return EXIT.OK;
}

async function handleScheduleCreate(argv, deps) {
  const apis = await buildApis(deps);
  const content = readMessageInput({
    positional: argv.message,
    fromFile: argv.fromFile,
    useStdin: Boolean(argv.stdin),
    stdin: deps.stdin,
  });
  const schedule = parseScheduleOptions(argv);
  const body = {
    content,
    sourceMessageId: argv.sourceMessageId ? String(argv.sourceMessageId) : null,
    schedule,
  };
  if (argv.dryRun) {
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload(
        "POST",
        `${buildBaseUrl(apis.config)}/api/tasks/${encodeURIComponent(argv.id)}/scheduled-messages`,
        body,
      ),
    );
    return EXIT.OK;
  }
  const result = await apis.tasks.createScheduledMessage(argv.id, body);
  const obj = scheduledMessageAsObject(result);
  if (argv.json) {
    printJson(deps.stdout, obj);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Created scheduled message ${obj.id} for task ${argv.id}`);
  if (obj.nextRunAt) {
    printPretty(deps.stdout, `Next run: ${obj.nextRunAt}`);
  }
  return EXIT.OK;
}

async function handleScheduleDelete(argv, deps) {
  const apis = await buildApis(deps);
  if (argv.dryRun) {
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload(
        "DELETE",
        `${buildBaseUrl(apis.config)}/api/tasks/${encodeURIComponent(argv.id)}/scheduled-messages/${encodeURIComponent(argv.scheduleId)}`,
        undefined,
      ),
    );
    return EXIT.OK;
  }
  await apis.tasks.deleteScheduledMessage(argv.id, argv.scheduleId);
  if (argv.json) {
    printJson(deps.stdout, { deleted: true, taskId: argv.id, scheduleId: argv.scheduleId });
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Deleted scheduled message ${argv.scheduleId} from task ${argv.id}`);
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
        "insert <id> [message]",
        "Insert a mid-turn message into a running task (interrupts the current turn so it runs next)",
        (cmd) => cmd
          .positional("id", { type: "string", demandOption: true })
          .positional("message", { type: "string" })
          .option("stdin", { type: "boolean", default: false })
          .option("from-file", { type: "string" })
          .option("target-reply-to", { type: "string", describe: "Reply target of the in-flight turn to interrupt (defaults to the latest user message)" })
          .option("metadata-json", { type: "string", describe: "Extra JSON metadata to merge into the message" }),
        async (argv) => {
          exitCode = await handleInsert(argv, { ...handlerDeps, configFile: argv.configFile });
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
      .command(
        "schedule",
        "Create, list, and delete scheduled messages for a task",
        (cmd) => cmd
          .command(
            "list <id>",
            "List scheduled messages for a task",
            (sub) => sub.positional("id", { type: "string", demandOption: true }),
            async (argv) => {
              exitCode = await handleScheduleList(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "create <id> [message]",
            "Create a scheduled message for a task",
            (sub) => sub
              .positional("id", { type: "string", demandOption: true })
              .positional("message", { type: "string" })
              .option("stdin", { type: "boolean", default: false })
              .option("from-file", { type: "string" })
              .option("source-message-id", { type: "string", describe: "Original message id, when scheduling a copy" })
              .option("delay", { type: "string", describe: "Send once after a duration, e.g. 10m or 2h" })
              .option("at", { type: "string", describe: "Send once at an ISO/local date-time string" })
              .option("every", { type: "string", describe: "Repeat every duration, e.g. 30m or 1h" })
              .option("if-idle", { type: "boolean", default: false, describe: "For repeats, only send when the AI is idle" })
              .option("max-runs", { type: "number", describe: "For repeats, stop after N sends" })
              .option("max-skips", { type: "number", describe: "For repeats, stop after N skips" })
              .option("stop-at", { type: "string", describe: "For repeats, stop after this date-time" })
              .option("keep-when-task-stopped", {
                type: "boolean",
                default: false,
                describe: "For repeats, skip instead of completing when the task is not running",
              }),
            async (argv) => {
              exitCode = await handleScheduleCreate(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "delete <id> <scheduleId>",
            "Delete an active scheduled message",
            (sub) => sub
              .positional("id", { type: "string", demandOption: true })
              .positional("scheduleId", { type: "string", demandOption: true }),
            async (argv) => {
              exitCode = await handleScheduleDelete(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .demandCommand(1),
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
