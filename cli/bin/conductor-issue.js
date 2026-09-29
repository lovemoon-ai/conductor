#!/usr/bin/env node

/**
 * conductor issue — entity-oriented issue management.
 *
 * Subcommands:
 *   list [--project ...] [--status <s>] [--limit N]
 *        [--all-projects | --project-ids a,b]   (cross-project listing)
 *   show <id>
 *   create --title <t> [--description <d> | --description-file FILE | --description-stdin]
 *          [--priority P1|P2|P3] [--status backlog|doing|done]
 *          [--client-request-id <key>] [--project ...]
 *   update <id> [--title ...] [--description ...] [--priority ...] [--status ...]
 *   start <id>          (alias for update --status doing)
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

function parseStatusList(value) {
  if (!value) return undefined;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
 * route has no status/limit params, so those filters are applied here.
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
  const raw = await http.get("/api/issues", {
    query: projectIds.length > 0 ? { project_ids: projectIds.join(",") } : undefined,
  });
  let issues = Array.isArray(raw) ? raw : [];
  const statuses = parseStatusList(argv.status);
  if (statuses && statuses.length > 0) {
    issues = issues.filter((issue) => statuses.includes(issue.status));
  }
  if (argv.limit) issues = issues.slice(0, Number(argv.limit));
  if (argv.json) {
    printJson(deps.stdout, issues);
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
  if (argv.allProjects || parseIdList(argv.projectIds).length > 0) {
    return handleListAcross(argv, deps);
  }
  const apis = await buildApis(deps);
  const project = await resolveProject(apis, { env: deps.env, cwd: deps.cwd, project: argv.project });
  const list = await apis.issues.listIssues({
    projectId: project.id,
    status: parseStatusList(argv.status),
    limit: argv.limit ? Number(argv.limit) : undefined,
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
  const metadata = buildAuditMetadata(deps.env);
  const body = {
    ...(argv.title ? { title: String(argv.title) } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(argv.priority ? { priority: String(argv.priority) } : {}),
    ...(status ? { status: String(status) } : {}),
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
          .option("status", { type: "string", describe: "Comma-separated status filter (e.g. backlog,doing)" })
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
          .option("priority", { choices: ["P1", "P2", "P3"] })
          .option("status", { choices: ["backlog", "doing", "done"] })
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
          .option("priority", { choices: ["P1", "P2", "P3"] })
          .option("status", { choices: ["backlog", "doing", "done"] }),
        async (argv) => {
          exitCode = await handleUpdate(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "start <id>",
        "Mark issue as doing (alias for update --status doing)",
        (cmd) => cmd.positional("id", { type: "string", demandOption: true }),
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
