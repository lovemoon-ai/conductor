#!/usr/bin/env node

/**
 * conductor project — entity-oriented project management.
 *
 * Subcommands:
 *   list [--include-hidden]
 *   show [<id|name>]
 *   current
 *   create [--name <n>] [--workspace-path <p>] [--daemon-host <h>] [--default] [--client-request-id <key>]
 *   set-default <id|name>
 *   hide <id|name>
 *   unhide <id|name>
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
  printJson,
  printPretty,
  pad,
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

async function resolveProjectSelector(apis, selector, options) {
  if (!selector) {
    return resolveProject(apis, options);
  }
  // Try id first via getProject(); fall back to name.
  if (typeof apis.projects.getProject === "function") {
    try {
      return await apis.projects.getProject(selector);
    } catch (err) {
      if ((err?.statusCode ?? err?.status) !== 404) {
        // not an id miss; rethrow so we don't paper over auth/transport errors
        if (err?.statusCode !== 400) throw err;
      }
    }
  }
  const list = await apis.projects.listProjects({ includeHidden: true });
  const matches = list.filter((entry) => entry.name === selector);
  if (matches.length === 0) {
    const err = new Error(`No project found matching '${selector}'`);
    err.statusCode = 404;
    throw err;
  }
  if (matches.length > 1) {
    const err = new Error(`Project name '${selector}' is ambiguous (${matches.length} matches); pass project id instead`);
    err.code = "ARGS";
    throw err;
  }
  return matches[0];
}

function projectAsObject(p) {
  if (!p) return null;
  if (typeof p.asObject === "function") return p.asObject();
  return {
    id: p.id,
    name: p.name,
    daemonHost: p.daemonHost,
    workspacePath: p.workspacePath,
    isDefault: p.isDefault,
    hidden: p.hidden ?? Boolean(p.hiddenAt),
  };
}

async function handleList(argv, deps) {
  const apis = await buildApis(deps);
  const list = await apis.projects.listProjects({ includeHidden: Boolean(argv.includeHidden) });
  const objects = list.map(projectAsObject);
  if (argv.json) {
    printJson(deps.stdout, objects);
    return EXIT.OK;
  }
  if (objects.length === 0) {
    printPretty(deps.stdout, "(no projects)");
    return EXIT.OK;
  }
  printPretty(deps.stdout, `${pad("ID", 24)} ${pad("DEFAULT", 8)} ${pad("HIDDEN", 7)} NAME`);
  for (const p of objects) {
    printPretty(
      deps.stdout,
      `${pad(p.id, 24)} ${pad(p.isDefault ? "yes" : "", 8)} ${pad(p.hidden ? "yes" : "", 7)} ${p.name ?? ""}`,
    );
  }
  return EXIT.OK;
}

async function handleShow(argv, deps) {
  const apis = await buildApis(deps);
  const selector = argv.idOrName ?? argv.project;
  const project = await resolveProjectSelector(apis, selector, {
    env: deps.env,
    cwd: deps.cwd,
  });
  const obj = projectAsObject(project);
  if (argv.json) {
    printJson(deps.stdout, obj);
    return EXIT.OK;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    printPretty(deps.stdout, `${key}: ${value}`);
  }
  return EXIT.OK;
}

async function handleCurrent(argv, deps) {
  const apis = await buildApis(deps);
  const project = await resolveProject(apis, { env: deps.env, cwd: deps.cwd, project: argv.project });
  const obj = projectAsObject(project);
  if (argv.json) {
    printJson(deps.stdout, obj);
    return EXIT.OK;
  }
  // Just the id, suitable for shell substitution.
  deps.stdout.write(`${obj.id}\n`);
  return EXIT.OK;
}

async function handleCreate(argv, deps) {
  const apis = await buildApis(deps);
  const config = apis.config;
  const env = deps.env;

  const cwd = deps.cwd;
  const workspacePath = argv.workspacePath
    ? path.resolve(argv.workspacePath)
    : cwd;
  const defaultName = argv.name && String(argv.name).trim()
    ? String(argv.name).trim()
    : (path.basename(workspacePath) || undefined);
  const daemonHost = argv.daemonHost ? String(argv.daemonHost) : undefined;
  const isDefault = Boolean(argv.default);
  const metadata = buildAuditMetadata(env);
  if (argv.clientRequestId) {
    metadata.clientRequestId = String(argv.clientRequestId);
  }

  const body = isDefault
    ? { isDefault: true, metadata }
    : {
        ...(defaultName ? { name: defaultName } : {}),
        ...(workspacePath ? { workspacePath } : {}),
        ...(daemonHost ? { daemonHost } : {}),
        metadata,
        ...(argv.clientRequestId ? { clientRequestId: String(argv.clientRequestId) } : {}),
      };

  if (argv.dryRun) {
    emitDryRun(
      deps.stdout,
      argv.json,
      makeDryRunPayload("POST", `${buildBaseUrl(config)}/api/projects`, body),
    );
    return EXIT.OK;
  }

  if (!isDefault) {
    if (!daemonHost && !config?.daemonName) {
      // Service-side will error when daemon is not reachable; we surface a
      // clearer hint here per "Decisions on leftover RFC questions" §1.
      // We don't proactively probe — but we *do* improve the wording when
      // the server returns "daemon not reachable".
    }
  }

  let created;
  try {
    created = await apis.projects.createProject(body);
  } catch (err) {
    if (isDaemonUnreachableError(err)) {
      const host = daemonHost || "(local daemon)";
      const friendly = new Error(
        `Daemon at ${host} not reachable. Start one with \`conductor daemon\` or pass --daemon-host <h> to use an existing one.`,
      );
      friendly.statusCode = err.statusCode;
      throw friendly;
    }
    throw err;
  }
  const obj = projectAsObject(created);
  if (argv.json) {
    printJson(deps.stdout, obj);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Created project ${obj.name ?? "(unnamed)"} (${obj.id})`);
  return EXIT.OK;
}

function isDaemonUnreachableError(err) {
  if (!err) return false;
  const message = err.message || "";
  if (/daemon/i.test(message) && /(not reachable|unreachable|cannot reach|connection refused|ECONN)/i.test(message)) {
    return true;
  }
  const details = err.details;
  if (details && typeof details === "object") {
    const detailMessage = String(details.error || details.message || "");
    if (/daemon/i.test(detailMessage) && /(not reachable|unreachable|cannot reach)/i.test(detailMessage)) {
      return true;
    }
  }
  return false;
}

async function handleSetDefault(argv, deps) {
  const apis = await buildApis(deps);
  const project = await resolveProjectSelector(apis, argv.idOrName, { env: deps.env, cwd: deps.cwd });
  // The matching server endpoint is `POST /api/projects/default` with body
  // `{ projectId, metadata }` (see web/src/app/api/projects/default/route.ts).
  // Earlier the dry-run preview pointed at the PATCH-by-query route, which
  // would have misled an AI agent inspecting the dry-run (review B3).
  const url = `${buildBaseUrl(apis.config)}/api/projects/default`;
  const metadata = buildAuditMetadata(deps.env);
  const body = { projectId: project.id, metadata };
  if (argv.dryRun) {
    emitDryRun(deps.stdout, argv.json, makeDryRunPayload("POST", url, body));
    return EXIT.OK;
  }
  const updated = await apis.projects.setDefaultProject(project.id, { metadata });
  if (argv.json) {
    printJson(deps.stdout, projectAsObject(updated));
    return EXIT.OK;
  }
  const display = updated?.name ?? project.name ?? project.id;
  printPretty(deps.stdout, `Default project set to ${display}`);
  return EXIT.OK;
}

async function handleSetHidden(argv, deps, hidden) {
  const apis = await buildApis(deps);
  const project = await resolveProjectSelector(apis, argv.idOrName, { env: deps.env, cwd: deps.cwd });
  const url = `${buildBaseUrl(apis.config)}/api/projects?projectId=${encodeURIComponent(project.id)}`;
  const metadata = buildAuditMetadata(deps.env);
  const body = { hidden, metadata };
  if (argv.dryRun) {
    emitDryRun(deps.stdout, argv.json, makeDryRunPayload("PATCH", url, body));
    return EXIT.OK;
  }
  // SDK signature: `setProjectHidden(idOrName, hidden, options?)`. Earlier we
  // were passing the whole body as the third arg, which the SDK silently
  // dropped — audit metadata never reached the server (review H2a).
  const updated = await apis.projects.setProjectHidden(project.id, hidden, { metadata });
  if (argv.json) {
    printJson(deps.stdout, projectAsObject(updated));
    return EXIT.OK;
  }
  printPretty(
    deps.stdout,
    hidden
      ? `Hid project ${project.name ?? project.id}`
      : `Unhid project ${project.name ?? project.id}`,
  );
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
      .scriptName("conductor project")
      .strict()
      .help()
      .option("json", { type: "boolean", default: false, describe: "Print machine-readable JSON" })
      .option("dry-run", { type: "boolean", default: false, describe: "Print the would-be request, don't send" })
      .option("project", { type: "string", describe: "Project id or name override" })
      .option("config-file", { type: "string", describe: "Path to Conductor config file" })
      .command(
        "list",
        "List projects",
        (cmd) => cmd.option("include-hidden", { type: "boolean", default: false }),
        async (argv) => {
          exitCode = await handleList(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "show [idOrName]",
        "Show a project (defaults to the resolved current project)",
        (cmd) => cmd.positional("idOrName", { type: "string" }),
        async (argv) => {
          exitCode = await handleShow(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "current",
        "Print the current project's id (or full JSON with --json)",
        (cmd) => cmd,
        async (argv) => {
          exitCode = await handleCurrent(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "create",
        "Create a new project",
        (cmd) => cmd
          .option("name", { type: "string", describe: "Project name (defaults to basename of workspace path)" })
          .option("workspace-path", { type: "string", describe: "Workspace path (defaults to cwd)" })
          .option("daemon-host", { type: "string", describe: "Daemon hostname for binding" })
          .option("default", { type: "boolean", default: false, describe: "Create the user's default project" })
          .option("client-request-id", { type: "string", describe: "Idempotency key" }),
        async (argv) => {
          exitCode = await handleCreate(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "set-default <idOrName>",
        "Set the user's default project",
        (cmd) => cmd.positional("idOrName", { type: "string", demandOption: true }),
        async (argv) => {
          exitCode = await handleSetDefault(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "hide <idOrName>",
        "Hide a project from default listings",
        (cmd) => cmd.positional("idOrName", { type: "string", demandOption: true }),
        async (argv) => {
          exitCode = await handleSetHidden(argv, { ...handlerDeps, configFile: argv.configFile }, true);
        },
      )
      .command(
        "unhide <idOrName>",
        "Unhide a previously hidden project",
        (cmd) => cmd.positional("idOrName", { type: "string", demandOption: true }),
        async (argv) => {
          exitCode = await handleSetHidden(argv, { ...handlerDeps, configFile: argv.configFile }, false);
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
