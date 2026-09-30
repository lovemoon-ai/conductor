#!/usr/bin/env node

/**
 * conductor settings — the user preferences behind the web settings page.
 *
 * Subcommands (all under /api/user-preferences unless noted):
 *   global-backends get                      GET   /global-ai-backends
 *   global-backends set (--json-body J | --from-file F)
 *                                            PUT   /global-ai-backends { backends: [{ host, backend }] }
 *   global-backends add <host> <backend>     GET then PUT (read-modify-write)
 *   global-backends remove <host> <backend>  GET then PUT (read-modify-write)
 *
 *   catchphrases list                        GET    /catchphrases
 *   catchphrases add <text...>               POST   /catchphrases { text }
 *   catchphrases update <id> <text...>       PATCH  /catchphrases/:id { text }
 *   catchphrases delete <id>                 DELETE /catchphrases/:id
 *   catchphrases reorder <id...>             PUT    /catchphrases/reorder { ids }  (full ordered set)
 *   catchphrases touch <id>                  POST   /catchphrases/:id/touch
 *
 *   daily-report get                         GET   /daily-report
 *   daily-report set [--enabled B] [--delivery-channels in_app,feishu] [--timezone TZ]
 *                                            PATCH /daily-report { enabled?, deliveryChannels? }
 *        The server takes the schedule timezone from the X-Client-Timezone
 *        header (the browser's zone on the web); the CLI sends --timezone or
 *        this machine's zone.
 *
 *   task-list get                            GET   /task-list
 *   task-list set (--running-only B | --json-body J | --from-file F)
 *                                            PATCH /task-list { tasksRunningOnly }
 *
 *   task-card-groups get|set                 GET / PATCH /task-card-groups    { scope, groups }
 *   project-card-groups get|set              GET / PATCH /project-card-groups { scope, groups }
 *        `set` takes --json-body/--from-file: either the full { scope, groups }
 *        object, or a bare groups array combined with --scope (default
 *        "projects:all", the scope the web UI writes).
 *
 *   reports list [--limit N]                 GET  /api/daily-reports?list=1&limit=N
 *   reports show [--date YYYY-MM-DD] [--timezone TZ]
 *                                            GET  /api/daily-reports?date=&timezone=
 *   reports generate [--date YYYY-MM-DD] [--timezone TZ]
 *                                            POST /api/daily-reports { reportDate, timezone }
 *        (`daily-reports` is an alias of `reports`; the generated daily reports
 *        live beside the daily-report *setting* so both are under `settings`.)
 *
 * Global flags: --json (raw response), --dry-run (write verbs print the request
 * instead of sending it), --config-file.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { EXIT, exitCodeForError, pad, printJson, printPretty, reportError } from "../src/entity-helpers.js";
import { apiPath, argsError, buildHttp, formatTable, parseJsonOption, sendOrPreview } from "../src/backend-http.js";

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

const PREFS = (...segments) => apiPath("user-preferences", ...segments);
const DEFAULT_CARD_GROUPS_SCOPE = "projects:all";
const DELIVERY_CHANNELS = ["in_app", "feishu"];

// ---------------------------------------------------------------- helpers

function readJsonBody(argv, { required = true } = {}) {
  if (argv.jsonBody !== undefined && argv.fromFile !== undefined) {
    throw argsError("Provide only one of --json-body and --from-file");
  }
  if (argv.jsonBody !== undefined) return parseJsonOption(argv.jsonBody, "--json-body");
  if (argv.fromFile !== undefined) {
    let text;
    try {
      text = fs.readFileSync(path.resolve(String(argv.fromFile)), "utf8");
    } catch (error) {
      throw argsError(`Cannot read --from-file: ${error.message}`);
    }
    return parseJsonOption(text, "--from-file");
  }
  if (required) throw argsError("Pass the new value with --json-body '<json>' or --from-file FILE");
  return undefined;
}

const jsonBodyOptions = (cmd) => cmd
  .option("json-body", { type: "string", describe: "Request body as JSON" })
  .option("from-file", { type: "string", describe: "Read the JSON request body from a file" });

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function joinText(value) {
  const text = [].concat(value ?? []).map(String).join(" ").trim();
  if (!text) throw argsError("Catchphrase text must not be empty");
  return text;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- global backends

function readBackends(payload) {
  return Array.isArray(payload?.backends) ? payload.backends : [];
}

function printBackends(argv, deps, payload) {
  if (argv.json) {
    printJson(deps.stdout, payload);
    return;
  }
  const backends = readBackends(payload);
  if (backends.length === 0) {
    printPretty(deps.stdout, "(no global AI backends)");
    return;
  }
  printPretty(deps.stdout, `${pad("HOST", 32)} BACKEND`);
  for (const entry of backends) {
    printPretty(deps.stdout, `${pad(entry.host, 32)} ${entry.backend}`);
  }
}

async function putBackends(http, argv, deps, backends, message) {
  const { dryRun, data } = await sendOrPreview(
    http, argv, deps, "PUT", PREFS("global-ai-backends"), { backends },
  );
  if (dryRun) return EXIT.OK;
  if (!argv.json && message) printPretty(deps.stdout, message);
  printBackends(argv, deps, data);
  return EXIT.OK;
}

async function handleBackendsGet(argv, deps) {
  const http = await buildHttp(deps);
  printBackends(argv, deps, await http.get(PREFS("global-ai-backends")));
  return EXIT.OK;
}

async function handleBackendsSet(argv, deps) {
  const body = readJsonBody(argv);
  const backends = Array.isArray(body) ? body : body?.backends;
  if (!Array.isArray(backends)) {
    throw argsError("Body must be { \"backends\": [{ \"host\", \"backend\" }] } or a bare array");
  }
  const http = await buildHttp(deps);
  return putBackends(http, argv, deps, backends, `Saved ${backends.length} global AI backend(s)`);
}

async function handleBackendsAdd(argv, deps) {
  const http = await buildHttp(deps);
  // Same normalization the server stores entries with (user-preferences.ts).
  const host = String(argv.host).trim();
  const backend = String(argv.backend).trim().toLowerCase();
  const current = readBackends(await http.get(PREFS("global-ai-backends")));
  if (current.some((entry) => entry.host === host && entry.backend === backend)) {
    if (argv.json) printJson(deps.stdout, { backends: current });
    else printPretty(deps.stdout, `${host} / ${backend} is already a global AI backend`);
    return EXIT.OK;
  }
  return putBackends(http, argv, deps, [...current, { host, backend }], `Added ${host} / ${backend}`);
}

async function handleBackendsRemove(argv, deps) {
  const http = await buildHttp(deps);
  // Same normalization the server stores entries with (user-preferences.ts).
  const host = String(argv.host).trim();
  const backend = String(argv.backend).trim().toLowerCase();
  const current = readBackends(await http.get(PREFS("global-ai-backends")));
  const next = current.filter((entry) => !(entry.host === host && entry.backend === backend));
  if (next.length === current.length) {
    const err = new Error(`${host} / ${backend} is not a global AI backend`);
    err.statusCode = 404;
    throw err;
  }
  return putBackends(http, argv, deps, next, `Removed ${host} / ${backend}`);
}

// ---------------------------------------------------------------- catchphrases

function printCatchphrases(argv, deps, payload, message) {
  if (argv.json) {
    printJson(deps.stdout, payload);
    return;
  }
  if (message) {
    printPretty(deps.stdout, message);
    return;
  }
  const list = Array.isArray(payload?.catchphrases) ? payload.catchphrases : [];
  if (list.length === 0) {
    printPretty(deps.stdout, "(no catchphrases)");
    return;
  }
  for (const line of formatTable(["ID", "TEXT"], list.map((item) => [item.id, oneLine(item.text)]))) {
    printPretty(deps.stdout, line);
  }
}

async function handleCatchphrasesList(argv, deps) {
  const http = await buildHttp(deps);
  printCatchphrases(argv, deps, await http.get(PREFS("catchphrases")));
  return EXIT.OK;
}

async function handleCatchphrasesAdd(argv, deps) {
  const text = joinText(argv.text);
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", PREFS("catchphrases"), { text });
  if (dryRun) return EXIT.OK;
  const list = Array.isArray(data?.catchphrases) ? data.catchphrases : [];
  const created = [...list].reverse().find((item) => item.text === text);
  printCatchphrases(argv, deps, data, `Added catchphrase${created ? ` ${created.id}` : ""}`);
  return EXIT.OK;
}

async function handleCatchphrasesUpdate(argv, deps) {
  const text = joinText(argv.text);
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http, argv, deps, "PATCH", PREFS("catchphrases", argv.id), { text },
  );
  if (dryRun) return EXIT.OK;
  printCatchphrases(argv, deps, data, `Updated catchphrase ${argv.id}`);
  return EXIT.OK;
}

async function handleCatchphrasesDelete(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http, argv, deps, "DELETE", PREFS("catchphrases", argv.id), undefined,
  );
  if (dryRun) return EXIT.OK;
  printCatchphrases(argv, deps, data, `Deleted catchphrase ${argv.id}`);
  return EXIT.OK;
}

async function handleCatchphrasesReorder(argv, deps) {
  const ids = [].concat(argv.ids ?? []).map(String).filter(Boolean);
  if (ids.length === 0) throw argsError("Pass the catchphrase ids in their new order");
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http, argv, deps, "PUT", PREFS("catchphrases", "reorder"), { ids },
    { note: "ids must list every catchphrase; the server rejects a partial set with 409" },
  );
  if (dryRun) return EXIT.OK;
  printCatchphrases(argv, deps, data, `Reordered ${ids.length} catchphrase(s)`);
  return EXIT.OK;
}

async function handleCatchphrasesTouch(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http, argv, deps, "POST", PREFS("catchphrases", argv.id, "touch"), undefined,
  );
  if (dryRun) return EXIT.OK;
  printCatchphrases(argv, deps, data, `Marked catchphrase ${argv.id} as used`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- daily report setting

function printDailyReportSetting(argv, deps, setting, message) {
  if (argv.json) {
    printJson(deps.stdout, setting);
    return;
  }
  if (message) printPretty(deps.stdout, message);
  const s = setting ?? {};
  const channels = s.deliveryChannels ?? s.delivery_channels ?? [];
  const rows = [
    ["enabled", s.enabled],
    ["timezone", s.timezone],
    ["send time", s.sendTimeLocal ?? s.send_time_local],
    ["channels", Array.isArray(channels) ? channels.join(", ") : channels],
    ["next run", s.nextRunAt ?? s.next_run_at],
    ["last run", s.lastRunAt ?? s.last_run_at],
    ["last sent for", s.lastSentForDate ?? s.last_sent_for_date],
    ["last error", s.lastError ?? s.last_error],
  ];
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === "") continue;
    printPretty(deps.stdout, `${pad(`${label}:`, 15)}${value}`);
  }
}

async function handleDailyReportGet(argv, deps) {
  const http = await buildHttp(deps);
  printDailyReportSetting(argv, deps, await http.get(PREFS("daily-report")));
  return EXIT.OK;
}

function parseChannels(value) {
  const channels = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  const bad = channels.filter((entry) => !DELIVERY_CHANNELS.includes(entry));
  if (bad.length > 0) {
    throw argsError(`Unknown delivery channel(s): ${bad.join(", ")} (valid: ${DELIVERY_CHANNELS.join(", ")})`);
  }
  return channels;
}

async function handleDailyReportSet(argv, deps) {
  const body = {
    ...(argv.enabled !== undefined ? { enabled: Boolean(argv.enabled) } : {}),
    ...(argv.deliveryChannels !== undefined ? { deliveryChannels: parseChannels(argv.deliveryChannels) } : {}),
  };
  if (Object.keys(body).length === 0) {
    throw argsError("Nothing to update: pass --enabled and/or --delivery-channels");
  }
  const timezone = argv.timezone ? String(argv.timezone) : localTimezone();
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http, argv, deps, "PATCH", PREFS("daily-report"), body,
    {
      ...(timezone ? { headers: { "X-Client-Timezone": timezone } } : {}),
      ...(timezone && body.enabled !== false ? { note: `schedule timezone sent as X-Client-Timezone: ${timezone}` } : {}),
    },
  );
  if (dryRun) return EXIT.OK;
  printDailyReportSetting(argv, deps, data, "Updated daily report setting");
  return EXIT.OK;
}

// ---------------------------------------------------------------- task list

function printTaskList(argv, deps, prefs, message) {
  if (argv.json) {
    printJson(deps.stdout, prefs);
    return;
  }
  if (message) printPretty(deps.stdout, message);
  printPretty(deps.stdout, `tasksRunningOnly: ${prefs?.tasksRunningOnly ?? prefs?.tasks_running_only ?? false}`);
}

async function handleTaskListGet(argv, deps) {
  const http = await buildHttp(deps);
  printTaskList(argv, deps, await http.get(PREFS("task-list")));
  return EXIT.OK;
}

async function handleTaskListSet(argv, deps) {
  let body;
  if (argv.runningOnly !== undefined) {
    if (argv.jsonBody !== undefined || argv.fromFile !== undefined) {
      throw argsError("Provide either --running-only or a JSON body, not both");
    }
    body = { tasksRunningOnly: Boolean(argv.runningOnly) };
  } else {
    body = readJsonBody(argv);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw argsError("Body must be an object like { \"tasksRunningOnly\": true }");
    }
  }
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "PATCH", PREFS("task-list"), body);
  if (dryRun) return EXIT.OK;
  printTaskList(argv, deps, data, "Updated task list preferences");
  return EXIT.OK;
}

// ---------------------------------------------------------------- card groups

function makeCardGroupHandlers(resource, memberKey, noun) {
  const route = PREFS(resource);

  function printSnapshot(argv, deps, snapshot, message) {
    if (argv.json) {
      printJson(deps.stdout, snapshot);
      return;
    }
    if (message) printPretty(deps.stdout, message);
    const scopes = snapshot?.scopes && typeof snapshot.scopes === "object" ? snapshot.scopes : {};
    printPretty(deps.stdout, `revision: ${snapshot?.revision ?? 0}`);
    const entries = Object.entries(scopes);
    if (entries.length === 0) {
      printPretty(deps.stdout, "(no card groups)");
      return;
    }
    for (const [scope, groups] of entries) {
      printPretty(deps.stdout, `scope ${scope}:`);
      const list = Array.isArray(groups) ? groups : [];
      if (list.length === 0) printPretty(deps.stdout, "  (empty)");
      for (const group of list) {
        const members = Array.isArray(group?.[memberKey]) ? group[memberKey] : [];
        printPretty(deps.stdout, `  ${pad(group?.id ?? "", 26)} ${members.length} ${noun}s: ${members.join(", ")}`);
      }
    }
  }

  return {
    async get(argv, deps) {
      const http = await buildHttp(deps);
      printSnapshot(argv, deps, await http.get(route));
      return EXIT.OK;
    },
    async set(argv, deps) {
      const parsed = readJsonBody(argv);
      let body;
      if (Array.isArray(parsed)) {
        body = { scope: String(argv.scope ?? DEFAULT_CARD_GROUPS_SCOPE), groups: parsed };
      } else if (parsed && typeof parsed === "object") {
        body = { ...parsed };
        if (argv.scope !== undefined) body.scope = String(argv.scope);
        if (body.scope === undefined) body.scope = DEFAULT_CARD_GROUPS_SCOPE;
      } else {
        throw argsError(`Body must be { "scope", "groups": [...] } or a bare groups array`);
      }
      if (!Array.isArray(body.groups)) throw argsError("groups must be an array");
      const http = await buildHttp(deps);
      const { dryRun, data } = await sendOrPreview(http, argv, deps, "PATCH", route, body);
      if (dryRun) return EXIT.OK;
      printSnapshot(argv, deps, data, `Saved ${body.groups.length} ${noun} card group(s) in ${body.scope}`);
      return EXIT.OK;
    },
  };
}

const taskCardGroups = makeCardGroupHandlers("task-card-groups", "taskIds", "task");
const projectCardGroups = makeCardGroupHandlers("project-card-groups", "projectIds", "project");

// ---------------------------------------------------------------- daily reports

function printReport(argv, deps, report, message) {
  if (argv.json) {
    printJson(deps.stdout, report);
    return;
  }
  if (message) printPretty(deps.stdout, message);
  const r = report ?? {};
  printPretty(deps.stdout, `date:     ${r.reportDate ?? r.report_date ?? ""}`);
  printPretty(deps.stdout, `timezone: ${r.timezone ?? ""}`);
  printPretty(deps.stdout, `status:   ${r.status ?? ""}${r.persisted === false ? " (not saved)" : ""}`);
  const sentAt = r.sentAt ?? r.sent_at;
  if (sentAt) printPretty(deps.stdout, `sent:     ${sentAt}`);
  const lastError = r.lastError ?? r.last_error;
  if (lastError) printPretty(deps.stdout, `error:    ${lastError}`);
  const summary = r.summaryMarkdown ?? r.summary_markdown;
  if (summary) {
    printPretty(deps.stdout, "");
    printPretty(deps.stdout, String(summary).trimEnd());
  }
}

function checkDate(value) {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw argsError("--date must be YYYY-MM-DD");
  return text;
}

async function handleReportsList(argv, deps) {
  const http = await buildHttp(deps);
  const result = await http.get(apiPath("daily-reports"), {
    query: { list: 1, ...(argv.limit !== undefined ? { limit: argv.limit } : {}) },
  });
  if (argv.json) {
    printJson(deps.stdout, result);
    return EXIT.OK;
  }
  const reports = Array.isArray(result?.reports) ? result.reports : [];
  if (reports.length === 0) {
    printPretty(deps.stdout, "(no daily reports)");
    return EXIT.OK;
  }
  printPretty(deps.stdout, `${pad("DATE", 11)} ${pad("STATUS", 11)} ${pad("TIMEZONE", 20)} SENT`);
  for (const r of reports) {
    printPretty(
      deps.stdout,
      `${pad(r.reportDate ?? r.report_date ?? "", 11)} ${pad(r.status ?? "", 11)} ${pad(r.timezone ?? "", 20)} ${r.sentAt ?? r.sent_at ?? "-"}`,
    );
  }
  return EXIT.OK;
}

async function handleReportsShow(argv, deps) {
  const date = checkDate(argv.date);
  const http = await buildHttp(deps);
  const report = await http.get(apiPath("daily-reports"), {
    query: { date, timezone: argv.timezone },
  });
  printReport(argv, deps, report);
  return EXIT.OK;
}

async function handleReportsGenerate(argv, deps) {
  const date = checkDate(argv.date);
  const body = {
    ...(date ? { reportDate: date } : {}),
    ...(argv.timezone ? { timezone: String(argv.timezone) } : {}),
  };
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", apiPath("daily-reports"), body);
  if (dryRun) return EXIT.OK;
  printReport(argv, deps, data, "Generated daily report");
  return EXIT.OK;
}

// ---------------------------------------------------------------- CLI

export async function main(argvInput = hideBin(process.argv), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const consoleErr = { error: (msg) => stderr.write(`${msg}\n`) };
  const handlerDeps = { ...deps, stdout, stderr, env, cwd };
  const run = (handler) => async (argv) => {
    exitCode = await handler(argv, { ...handlerDeps, configFile: argv.configFile });
  };
  const noop = () => {};
  const idArg = (cmd) => cmd.positional("id", { type: "string", demandOption: true });
  const hostBackendArgs = (cmd) => cmd
    .positional("host", { type: "string", demandOption: true, describe: "Daemon host name" })
    .positional("backend", { type: "string", demandOption: true, describe: "AI backend (e.g. claude, codex)" });
  const scopeOption = (cmd) => jsonBodyOptions(cmd)
    .option("scope", { type: "string", describe: `Scope for a bare groups array (default ${DEFAULT_CARD_GROUPS_SCOPE})` });
  const reportTzOption = (cmd) => cmd
    .option("date", { type: "string", describe: "Report date YYYY-MM-DD (default: today)" })
    .option("timezone", { type: "string", describe: "IANA timezone (default: your daily report setting)" });

  let exitCode = EXIT.OK;
  try {
    await yargs(argvInput)
      .scriptName("conductor settings")
      .strict()
      .help()
      .option("json", { type: "boolean", default: false })
      .option("dry-run", { type: "boolean", default: false })
      .option("config-file", { type: "string", describe: "Path to Conductor config file" })
      .command("global-backends", "Daemon x AI backends any project may run tasks on", (y) => y
        .command("get", "Show global AI backends", noop, run(handleBackendsGet))
        .command("set", "Replace the whole list", jsonBodyOptions, run(handleBackendsSet))
        .command("add <host> <backend>", "Add one host/backend pair", hostBackendArgs, run(handleBackendsAdd))
        .command("remove <host> <backend>", "Remove one host/backend pair", hostBackendArgs, run(handleBackendsRemove))
        .demandCommand(1))
      .command("catchphrases", "Saved chat composer phrases", (y) => y
        .command("list", "List catchphrases", noop, run(handleCatchphrasesList))
        .command("add <text..>", "Add a catchphrase",
          (cmd) => cmd.positional("text", { type: "string", array: true }), run(handleCatchphrasesAdd))
        .command("update <id> <text..>", "Change a catchphrase's text",
          (cmd) => idArg(cmd).positional("text", { type: "string", array: true }), run(handleCatchphrasesUpdate))
        .command("delete <id>", "Delete a catchphrase", idArg, run(handleCatchphrasesDelete))
        .command("reorder <ids..>", "Set the order (list every id)",
          (cmd) => cmd.positional("ids", { type: "string", array: true }), run(handleCatchphrasesReorder))
        .command("touch <id>", "Mark a catchphrase as just used", idArg, run(handleCatchphrasesTouch))
        .demandCommand(1))
      .command("daily-report", "Daily report schedule setting", (y) => y
        .command("get", "Show the daily report setting", noop, run(handleDailyReportGet))
        .command("set", "Update the daily report setting", (cmd) => cmd
          .option("enabled", { type: "boolean", describe: "Turn the daily report on or off" })
          .option("delivery-channels", { type: "string", describe: `Comma-separated: ${DELIVERY_CHANNELS.join(",")}` })
          .option("timezone", { type: "string", describe: "Schedule timezone (default: this machine's)" }),
        run(handleDailyReportSet))
        .demandCommand(1))
      .command(["reports", "daily-reports"], "Generated daily reports", (y) => y
        .command("list", "List recent daily reports",
          (cmd) => cmd.option("limit", { type: "number", describe: "Max reports (server default 14, max 60)" }),
          run(handleReportsList))
        .command("show", "Show one day's report", reportTzOption, run(handleReportsShow))
        .command("generate", "Generate (and save) a day's report", reportTzOption, run(handleReportsGenerate))
        .demandCommand(1))
      .command("task-list", "Task list view preferences", (y) => y
        .command("get", "Show task list preferences", noop, run(handleTaskListGet))
        .command("set", "Update task list preferences", (cmd) => jsonBodyOptions(cmd)
          .option("running-only", { type: "boolean", describe: "Show only running tasks" }),
        run(handleTaskListSet))
        .demandCommand(1))
      .command("task-card-groups", "Grouped task cards", (y) => y
        .command("get", "Show task card groups", noop, run(taskCardGroups.get))
        .command("set", "Replace the task card groups of a scope", scopeOption, run(taskCardGroups.set))
        .demandCommand(1))
      .command("project-card-groups", "Grouped project cards", (y) => y
        .command("get", "Show project card groups", noop, run(projectCardGroups.get))
        .command("set", "Replace the project card groups of a scope", scopeOption, run(projectCardGroups.set))
        .demandCommand(1))
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
