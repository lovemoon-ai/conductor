#!/usr/bin/env node

/**
 * conductor issue — entity-oriented issue management.
 *
 * Subcommands:
 *   list [--project ...] [--status <s>] [--limit N]
 *        [--all-projects | --project-ids a,b]   (cross-project listing)
 *   show <id>
 *   create --title <t> [--description <d> | --description-file FILE | --description-stdin]
 *          [--priority P0|P1|P2] [--status todo|done]
 *          [--client-request-id <key>] [--project ...]
 *   update <id> [--title ...] [--description ...] [--priority ...] [--status ...]
 *   start <id> [--backend <b>] [--global-backend <backend>@<host>]
 *              [--daemon <host>] [--project <id>]
 *                       (alias for update --status doing)
 *   done <id> [--evidence <text>|@FILE]
 *   delete <id> --yes    (the server refuses issues still in doing)
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
  readDescription,
  readEvidence,
  reportError,
  resolveProject,
} from "../src/entity-helpers.js";
import { apiPath, argsError, buildHttp, sendOrPreview, formatTable, projectLabels } from "../src/backend-http.js";

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

function buildBaseUrl(config) {
  const raw = (config?.backendUrl || "").replace(/\/+$/, "");
  return raw || "http://localhost";
}

function issueAsObject(issue) {
  if (!issue) return null;
  if (typeof issue.asObject === "function") return issue.asObject();
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    description: issue.description,
    projectId: issue.projectId,
    metadata: issue.metadata,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

// `codex@ubuntu` → { backend: "codex", host: "ubuntu" } (RFC 0041 global AI backend).
function parseGlobalBackend(value) {
  if (value === undefined) return undefined;
  const raw = String(value).trim();
  const at = raw.indexOf("@");
  const backend = at > 0 ? raw.slice(0, at).trim().toLowerCase() : "";
  const host = at > 0 ? raw.slice(at + 1).trim() : "";
  if (!backend || !host) {
    const err = new Error(`--global-backend must look like <backend>@<host>, got "${raw}"`);
    err.code = "ARGS";
    throw err;
  }
  return { host, backend };
}

function parseStatusList(value) {
  if (!value) return undefined;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Legacy statuses the server serves as their canonical value
// (web/src/lib/issues/config.ts LEGACY_ISSUE_STATUS_ALIASES).
const LEGACY_ISSUE_STATUS_ALIASES = { backlog: "todo", review: "doing" };
function canonicalIssueStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return LEGACY_ISSUE_STATUS_ALIASES[normalized] ?? normalized;
}

function parseIdList(value) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

/**
 * Cross-project listing straight off GET /api/issues: no `project_id` lists
 * every project the user can access (own + collaborations); `project_ids`
 * lists exactly those projects (what the merged cross-daemon view uses). The
 * server filters `status` (older servers ignore it, so it is re-applied here);
 * the route has no limit param, so that is applied here.
 */
async function handleListAcross(argv, deps) {
  const projectIds = parseIdList(argv.projectIds);
  if (argv.allProjects && projectIds.length > 0) {
    throw argsError("Pass either --all-projects or --project-ids, not both");
  }
  if (argv.project && (argv.allProjects || projectIds.length > 0)) {
    throw argsError("--project cannot be combined with --all-projects/--project-ids");
  }
  const http = await buildHttp(deps);
  const statuses = parseStatusList(argv.status);
  const query = {
    ...(projectIds.length > 0 ? { project_ids: projectIds.join(",") } : {}),
    ...(statuses && statuses.length > 0 ? { status: statuses.join(",") } : {}),
  };
  const raw = await http.get("/api/issues", {
    query: Object.keys(query).length > 0 ? query : undefined,
  });
  let issues = Array.isArray(raw) ? raw : [];
  if (statuses && statuses.length > 0) {
    const wanted = new Set(statuses.map(canonicalIssueStatus));
    issues = issues.filter((issue) => wanted.has(canonicalIssueStatus(issue.status)));
  }
  if (argv.limit !== undefined) issues = issues.slice(0, argv.limit);
  if (argv.json) {
    // Same shape as the single-project `list --json` (the SDK-normalized form).
    printJson(deps.stdout, issues.map((issue) => issueAsObject({
      ...issue,
      projectId: issue.projectId ?? issue.project_id,
      createdAt: issue.createdAt ?? issue.created_at,
      updatedAt: issue.updatedAt ?? issue.updated_at,
    })));
    return EXIT.OK;
  }
  if (issues.length === 0) {
    printPretty(deps.stdout, "(no issues)");
    return EXIT.OK;
  }
  const names = await projectLabels(http);
  const rows = issues.map((issue) => {
    const projectId = issue.projectId ?? issue.project_id ?? "";
    const projectLabel = issue.projectName ?? issue.project_name ?? names.get(projectId) ?? projectId;
    return [issue.id, projectLabel, issue.status ?? "", issue.priority ?? "", issue.title ?? ""];
  });
  for (const line of formatTable(["ID", "PROJECT", "STATUS", "PRIO", "TITLE"], rows)) {
    printPretty(deps.stdout, line);
  }
  return EXIT.OK;
}

async function handleDelete(argv, deps) {
  if (!argv.yes && !argv.dryRun) {
    throw argsError("Refusing to delete without --yes");
  }
  const http = await buildHttp(deps);
  const result = await sendOrPreview(http, argv, deps, "DELETE", apiPath("issues", argv.id), undefined);
  if (result.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, { deleted: true, id: argv.id });
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Deleted issue ${argv.id}`);
  return EXIT.OK;
}

async function handleList(argv, deps) {
  if (argv.limit !== undefined && !(Number.isInteger(argv.limit) && argv.limit > 0)) {
    throw argsError("--limit must be a positive integer");
  }
  if (argv.allProjects || parseIdList(argv.projectIds).length > 0) {
    return handleListAcross(argv, deps);
  }
  const apis = await buildApis(deps);
  const project = await resolveProject(apis, { env: deps.env, cwd: deps.cwd, project: argv.project });
  const list = await apis.issues.listIssues({
    projectId: project.id,
    status: parseStatusList(argv.status),
    limit: argv.limit,
  });
  const objects = (Array.isArray(list) ? list : []).map(issueAsObject);
  if (argv.json) {
    printJson(deps.stdout, objects);
    return EXIT.OK;
  }
  if (objects.length === 0) {
    printPretty(deps.stdout, "(no issues)");
    return EXIT.OK;
  }
  printPretty(deps.stdout, `${pad("ID", 24)} ${pad("STATUS", 9)} ${pad("PRIO", 5)} TITLE`);
  for (const issue of objects) {
    printPretty(
      deps.stdout,
      `${pad(issue.id, 24)} ${pad(issue.status, 9)} ${pad(issue.priority ?? "", 5)} ${issue.title ?? ""}`,
    );
  }
  return EXIT.OK;
}

async function handleShow(argv, deps) {
  const apis = await buildApis(deps);
  const issue = await apis.issues.getIssue(argv.id);
  if (!issue) {
    const err = new Error(`Issue not found: ${argv.id}`);
    err.statusCode = 404;
    throw err;
  }
  const obj = issueAsObject(issue);
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

async function handleCreate(argv, deps) {
  const apis = await buildApis(deps);
  const project = await resolveProject(apis, { env: deps.env, cwd: deps.cwd, project: argv.project });
  const description = readDescription({
    description: argv.description,
    descriptionFile: argv.descriptionFile,
    descriptionStdin: argv.descriptionStdin,
    stdin: deps.stdin,
  });
  const metadata = buildAuditMetadata(deps.env);
  const body = {
    projectId: project.id,
    title: String(argv.title),
    ...(description !== undefined ? { description } : {}),
    ...(argv.priority ? { priority: String(argv.priority) } : {}),
    ...(argv.status ? { status: String(argv.status) } : {}),
    ...(argv.clientRequestId ? { clientRequestId: String(argv.clientRequestId) } : {}),
    metadata,
  };
  if (argv.dryRun) {
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload("POST", `${buildBaseUrl(apis.config)}/api/issues`, body),
    );
    return EXIT.OK;
  }
  const created = await apis.issues.createIssue(body);
  const obj = issueAsObject(created);
  if (argv.json) {
    printJson(deps.stdout, obj);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Created issue ${obj.id}: ${obj.title}`);
  return EXIT.OK;
}

/**
 * Target project for `issue start`: `--project` as given, else — for
 * `--daemon` on a project bound to another daemon — the same-named sibling
 * project on that daemon. The server re-checks that it is a merged sibling.
 */
async function resolveStartProjectId(apis, argv, daemonHost) {
  if (argv.project) {
    return (await resolveProject(apis, { project: argv.project })).id;
  }
  if (!daemonHost) return undefined;
  const issue = await apis.issues.getIssue(argv.id);
  let current;
  try {
    current = await apis.projects.getProject(issue.projectId);
  } catch (err) {
    // Another member's shared project is not readable here: skip the sibling
    // pick and let the server explain what it allows.
    const status = err?.statusCode ?? err?.status;
    const notFound = err?.name === "ProjectNotResolvedError" && err.reason === "not_found";
    if (notFound || status === 404 || status === 403) return undefined;
    throw err;
  }
  if (!current.daemonHost || current.daemonHost === daemonHost) return undefined;
  const siblings = (await apis.projects.listProjects()).filter(
    (project) => project.name === current.name && project.daemonHost === daemonHost,
  );
  if (siblings.length !== 1) {
    throw argsError(
      siblings.length === 0
        ? `No project "${current.name}" on daemon ${daemonHost}; pass --project <id>`
        : `Several projects "${current.name}" on daemon ${daemonHost}; pass --project <id>`,
    );
  }
  return siblings[0].id;
}

async function handleUpdate(argv, deps, overrides = {}) {
  const apis = await buildApis(deps);
  const description = readDescription({
    description: argv.description,
    descriptionFile: argv.descriptionFile,
    descriptionStdin: argv.descriptionStdin,
    stdin: deps.stdin,
  });
  // `--description ""` is intentionally treated as a no-op (readDescription
  // returns undefined). To clear an existing description, the server expects
  // an explicit `null` — exposing that requires a follow-up flag and is out of
  // scope here (review M5 — current behavior accepted as documented).
  const status = overrides.status || argv.status;
  const evidence = overrides.evidence;
  const globalBackend = parseGlobalBackend(argv.globalBackend);
  // The server reads the spawned task's backend from `metadata.backendType`.
  const backendType = globalBackend?.backend ?? (argv.backend ? String(argv.backend) : undefined);
  const daemonHost = argv.daemon ? String(argv.daemon).trim() : undefined;
  const metadata = buildAuditMetadata(deps.env, {
    ...(backendType ? { backendType } : {}),
    ...(daemonHost ? { daemonHost } : {}),
  });
  // `start` only: the web's doing dialog re-parents the issue onto the chosen
  // daemon's sibling project in a merged cross-daemon group.
  const targetProjectId = overrides.status === "doing"
    ? await resolveStartProjectId(apis, argv, daemonHost)
    : undefined;
  const body = {
    ...(targetProjectId ? { projectId: targetProjectId } : {}),
    ...(argv.title ? { title: String(argv.title) } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(argv.priority ? { priority: String(argv.priority) } : {}),
    ...(status ? { status: String(status) } : {}),
    ...(globalBackend ? { globalBackend } : {}),
    metadata,
  };
  if (Object.keys(body).filter((key) => key !== "metadata").length === 0) {
    const err = new Error("Nothing to update: pass at least one of --title/--description/--priority/--status");
    err.code = "ARGS";
    throw err;
  }
  if (argv.dryRun) {
    // Surface evidence in the preview body so the user sees what the SDK will
    // merge into `metadata.qa.evidence` server-side. The real call still
    // round-trips the existing metadata; this preview is an approximation.
    const previewBody = evidence === undefined
      ? body
      : {
          ...body,
          metadata: {
            ...body.metadata,
            qa: { ...((body.metadata && body.metadata.qa) || {}), evidence },
          },
        };
    const previewOptions = evidence !== undefined
      ? { note: "preview omits server-side metadata round-trip; live PATCH merges existing metadata.qa fields" }
      : {};
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload(
        "PATCH",
        `${buildBaseUrl(apis.config)}/api/issues/${encodeURIComponent(argv.id)}`,
        previewBody,
        previewOptions,
      ),
    );
    return EXIT.OK;
  }
  // Pick the SDK call:
  //   - If we have `evidence`, route through `updateIssueStatus` so the SDK
  //     round-trips the existing metadata and merges `qa.evidence` instead of
  //     clobbering. We pass `metadata` so the CLI's audit namespace flows
  //     through.
  //   - Otherwise call `updateIssue` so a multi-field patch (title + status)
  //     reaches the server intact (review B2: previously the CLI passed the
  //     full body as the SDK's third arg, which was ignored).
  let updated;
  if (evidence !== undefined && status && typeof apis.issues.updateIssueStatus === "function") {
    updated = await apis.issues.updateIssueStatus(argv.id, String(status), {
      evidence,
      metadata,
    });
  } else {
    updated = await apis.issues.updateIssue(argv.id, body);
  }
  if (globalBackend) {
    // A server that predates issue global backends drops the field and still
    // starts a plain task on the project's own daemon.
    const task = updated?.raw?.activeTask;
    const ranOn = task?.agentHost ?? task?.agent_host ?? null;
    if (ranOn !== globalBackend.host) {
      deps.stderr.write(
        `warning: the task did not start on ${globalBackend.backend}@${globalBackend.host}`
          + ` (${ranOn ? `it runs on ${ranOn}` : "no task was started"});`
          + " the Conductor server may be too old for --global-backend\n",
      );
    }
  }
  const obj = issueAsObject(updated);
  if (argv.json) {
    printJson(deps.stdout, obj);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Updated issue ${obj.id}`);
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
      .scriptName("conductor issue")
      .strict()
      .help()
      .option("json", { type: "boolean", default: false })
      .option("dry-run", { type: "boolean", default: false })
      .option("project", { type: "string", describe: "Project id or name override" })
      .option("config-file", { type: "string", describe: "Path to Conductor config file" })
      .command(
        "list",
        "List issues",
        (cmd) => cmd
          .option("status", { type: "string", describe: "Comma-separated status filter: todo,doing,done" })
          .option("limit", { type: "number" })
          .option("all-projects", { type: "boolean", default: false, describe: "List issues across every accessible project" })
          .option("project-ids", { type: "string", describe: "Comma-separated project ids to list issues across" }),
        async (argv) => {
          exitCode = await handleList(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "show <id>",
        "Show one issue's full detail",
        (cmd) => cmd.positional("id", { type: "string", demandOption: true }),
        async (argv) => {
          exitCode = await handleShow(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "create",
        "Create a new issue",
        (cmd) => cmd
          .option("title", { type: "string", demandOption: true })
          .option("description", { type: "string" })
          .option("description-file", { type: "string" })
          .option("description-stdin", { type: "boolean", default: false })
          .option("priority", { choices: ["P0", "P1", "P2"] })
          // Only moving into doing starts an issue's task: create, then `start`.
          .option("status", { choices: ["todo", "done"] })
          .option("client-request-id", { type: "string" }),
        async (argv) => {
          exitCode = await handleCreate(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "update <id>",
        "Update an issue's fields (any subset)",
        (cmd) => cmd
          .positional("id", { type: "string", demandOption: true })
          .option("title", { type: "string" })
          .option("description", { type: "string" })
          .option("description-file", { type: "string" })
          .option("description-stdin", { type: "boolean", default: false })
          .option("priority", { choices: ["P0", "P1", "P2"] })
          .option("status", { choices: ["todo", "doing", "done"] }),
        async (argv) => {
          exitCode = await handleUpdate(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "start <id>",
        "Mark issue as doing (alias for update --status doing)",
        (cmd) => cmd
          .positional("id", { type: "string", demandOption: true })
          .option("backend", { type: "string", describe: "AI backend for the spawned task, e.g. codex or claude" })
          .option("global-backend", {
            type: "string",
            describe: "Run the AI on a global AI backend from settings, as <backend>@<host>",
          })
          .option("daemon", {
            type: "string",
            describe: "Daemon to run the task on (merged cross-daemon groups and the default project)",
          })
          .conflicts("backend", "global-backend"),
        async (argv) => {
          exitCode = await handleUpdate(argv, { ...handlerDeps, configFile: argv.configFile }, { status: "doing" });
        },
      )
      .command(
        "done <id>",
        "Mark issue as done (optionally attach QA evidence)",
        (cmd) => cmd
          .positional("id", { type: "string", demandOption: true })
          .option("evidence", { type: "string", describe: "Inline text or @path/to/file" }),
        async (argv) => {
          const evidence = readEvidence(argv.evidence);
          exitCode = await handleUpdate(argv, { ...handlerDeps, configFile: argv.configFile }, {
            status: "done",
            ...(evidence !== undefined ? { evidence } : {}),
          });
        },
      )
      .command(
        "delete <id>",
        "Delete an issue (requires --yes)",
        (cmd) => cmd
          .positional("id", { type: "string", demandOption: true })
          .option("yes", { type: "boolean", default: false, describe: "Confirm the deletion" }),
        async (argv) => {
          exitCode = await handleDelete(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .demandCommand(1)
      .fail((msg, err) => {
        if (err) {
          throw err;
        }
        // Throw so yargs stops here; returning would still run the command
        // (e.g. `create --priority P3` was sent to the server anyway).
        throw argsError(msg);
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
