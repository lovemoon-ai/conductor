#!/usr/bin/env node

/**
 * conductor project — entity-oriented project management.
 *
 * Subcommands:
 *   list [--include-hidden]
 *   show [<id|name>]
 *   current
 *   create [--name <n>] [--workspace-path <p>] [--daemon-host <h>] [--create-workspace] [--default] [--client-request-id <key>]
 *   set-default <id|name>
 *   hide <id|name>
 *   unhide <id|name>
 *   update <id|name> [--name <n>] [--merge-opt-out true|false]
 *          [--workspace-path <p> [--bind-daemon-host <h>]] [--json-body '{...}']
 *   refresh <id|name>                 (re-validate binding with the daemon)
 *   delete <id|name> --yes            (merged: every daemon unless --daemon-host picks one)
 *   reorder <id|name>...              (listed first, the rest keep their order)
 *   agents [<id|name>]                (agents registered in .conductor/settings.yaml)
 *   collab invite [<id|name>]
 *   collab join <token|invite-url> (--into <id|name> | --create-project <name>)
 *   collab leave <id|name>
 *   collab show-invite <token|invite-url>
 *   labels list [<id|name>]
 *   labels add <name>                 (target project via --project)
 *   labels rename <label> <new-name>
 *   labels remove <label>
 *
 * Positional <id|name> commands accept --daemon-host to disambiguate
 * same-name projects across daemons.
 *
 * Global flags supported on every write subcommand:
 *   --json, --dry-run, --project, --config-file
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
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
import { apiPath, argsError, buildHttp, parseJsonOption, sendOrPreview } from "../src/backend-http.js";

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

function buildBaseUrl(config) {
  const raw = (config?.backendUrl || "").replace(/\/+$/, "");
  return raw || "http://localhost";
}

async function resolveProjectSelector(apis, selector, options = {}) {
  if (!selector) {
    return resolveProject(apis, options);
  }
  const daemonHostFilter = options.daemonHost
    ? String(options.daemonHost).trim()
    : null;

  // Pull the project list once and do all matching client-side. We
  // deliberately do NOT route through `ProjectsApi.getProject` because the
  // SDK's variant transparently falls back from "id miss" to "unique name
  // match" — which collapses two semantically distinct cases (id miss vs.
  // ambiguous name) into one error, and prevents us from surfacing the
  // candidate list. Doing it locally keeps that distinction.
  const list = await apis.projects.listProjects({ includeHidden: true });

  const byId = list.find((entry) => entry.id === selector);
  if (byId) {
    if (daemonHostFilter && byId.daemonHost && byId.daemonHost !== daemonHostFilter) {
      const err = new Error(
        `Project ${byId.id} is on daemon '${byId.daemonHost}', not '${daemonHostFilter}'`,
      );
      err.code = "ARGS";
      throw err;
    }
    return byId;
  }

  const nameMatches = list.filter((entry) => entry.name === selector);
  const matches = daemonHostFilter
    ? nameMatches.filter((entry) => entry.daemonHost === daemonHostFilter)
    : nameMatches;
  if (matches.length === 0) {
    const hint = daemonHostFilter
      ? ` (no match on daemon '${daemonHostFilter}')`
      : "";
    const err = new Error(`No project found matching '${selector}'${hint}`);
    err.statusCode = 404;
    throw err;
  }
  if (matches.length > 1) {
    // Surface candidates inline so the caller can copy-paste the right id
    // without a second `conductor project list` round-trip (multi-daemon UX
    // follow-up to RFC 0025).
    const candidates = nameMatches
      .map((entry) => `  ${entry.id}  daemon=${entry.daemonHost ?? "(none)"}  ${entry.workspacePath ?? ""}`.trimEnd())
      .join("\n");
    const err = new Error(
      `Project name '${selector}' is ambiguous (${matches.length} matches). Pass --project <id> or --daemon-host <host> to disambiguate:\n${candidates}`,
    );
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
  // DAEMON column width sized for typical hostnames (e.g. "4090", "m1",
  // "macbook-pro"). Longer hosts overflow rather than truncate — readability
  // for the common case beats column alignment for outliers.
  const daemonColWidth = 14;
  printPretty(
    deps.stdout,
    `${pad("ID", 24)} ${pad("DEFAULT", 8)} ${pad("HIDDEN", 7)} ${pad("DAEMON", daemonColWidth)} NAME`,
  );
  for (const p of objects) {
    printPretty(
      deps.stdout,
      `${pad(p.id, 24)} ${pad(p.isDefault ? "yes" : "", 8)} ${pad(p.hidden ? "yes" : "", 7)} ${pad(p.daemonHost ?? "", daemonColWidth)} ${p.name ?? ""}`,
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
    daemonHost: argv.daemonHost,
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
  // workspacePath is a path on this machine, so bind to this machine's daemon
  // unless told otherwise (the server needs daemonHost + workspacePath).
  const daemonHost = argv.daemonHost ? String(argv.daemonHost) : localDaemonName(config, env);
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
        ...(argv.createWorkspace ? { createWorkspaceIfMissing: true } : {}),
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

  let created;
  try {
    created = await apis.projects.createProject(body);
  } catch (err) {
    if (isDaemonUnreachableError(err)) {
      const serverMessage = String(err.details?.error || err.message || "").trim();
      const friendly = new Error(
        `${serverMessage.replace(/\.?$/, ".")} Start it with \`conductor daemon\`, or pass --daemon-host <h> to use another online daemon.`,
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

/** The daemon name `conductor daemon` registers with on this machine. */
function localDaemonName(config, env) {
  const name =
    (typeof config?.daemonName === "string" && config.daemonName.trim()) ||
    (typeof env?.CONDUCTOR_DAEMON_NAME === "string" && env.CONDUCTOR_DAEMON_NAME.trim()) ||
    os.hostname().trim();
  return name || undefined;
}

// The server answers 409 with `code` daemon_offline / daemon_unreachable
// (web/src/lib/projects/daemon-binding.ts).
function isDaemonUnreachableError(err) {
  if (!err) return false;
  const code = err.details?.code;
  if (code === "daemon_offline" || code === "daemon_unreachable") return true;
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
  const project = await resolveProjectSelector(apis, argv.idOrName, {
    env: deps.env,
    cwd: deps.cwd,
    daemonHost: argv.daemonHost,
  });
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
  const project = await resolveProjectSelector(apis, argv.idOrName, {
    env: deps.env,
    cwd: deps.cwd,
    daemonHost: argv.daemonHost,
  });
  // Like the web project list, a cross-daemon merged project is hidden or
  // restored on every daemon at once.
  const members = displayedGroup(await apis.projects.listProjects({ includeHidden: true }), project);
  // No `metadata` here: the project PATCH route replaces the whole metadata
  // blob with whatever it is sent, so an audit-only object would erase the
  // project's task labels, memos and binding data. The web UI sends `hidden` alone.
  const body = { hidden };
  if (argv.dryRun) {
    for (const member of members) {
      const url = `${buildBaseUrl(apis.config)}/api/projects?projectId=${encodeURIComponent(member.id)}`;
      emitDryRun(deps.stdout, argv.json, makeDryRunPayload("PATCH", url, body));
    }
    return EXIT.OK;
  }
  const updated = [];
  for (const member of members) {
    updated.push(await apis.projects.setProjectHidden(member.id, hidden));
  }
  if (argv.json) {
    // The target's object, as before merged groups; `ids` lists every member changed.
    const target = projectAsObject(updated[members.findIndex((member) => member.id === project.id)] ?? updated[0]);
    printJson(deps.stdout, members.length > 1 ? { ...target, ids: members.map((member) => member.id) } : target);
    return EXIT.OK;
  }
  const what = members.length > 1
    ? `merged project ${project.name ?? project.id} on ${members.length} daemons`
    : `project ${project.name ?? project.id}`;
  printPretty(deps.stdout, hidden ? `Hid ${what}` : `Unhid ${what}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// HTTP-backed subcommands (routes the SDK does not wrap). See
// web/src/app/api/projects/** and web/src/features/projects/store.ts.
// ---------------------------------------------------------------------------

async function resolveTarget(argv, deps, selector = argv.idOrName ?? argv.project) {
  const apis = await buildApis(deps);
  return resolveProjectSelector(apis, selector, {
    env: deps.env,
    cwd: deps.cwd,
    project: argv.project,
    daemonHost: argv.daemonHost,
  });
}

async function listRawProjects(http) {
  const raw = await http.get("/api/projects");
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.projects)) return raw.projects;
  return [];
}

async function fetchRawProject(http, projectId) {
  const list = await listRawProjects(http);
  const found = list.find((entry) => entry && entry.id === projectId);
  if (!found) {
    const err = new Error(`Project not found: ${projectId}`);
    err.statusCode = 404;
    throw err;
  }
  return found;
}

function projectQuery(projectId) {
  return { projectId };
}

function displayName(project) {
  return `${project?.name ?? "(unnamed)"} (${project?.id})`;
}

function parseBooleanFlag(value, flag) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw argsError(`${flag} must be true or false`);
}

async function handleUpdate(argv, deps) {
  const project = await resolveTarget(argv, deps);
  const http = await buildHttp(deps);
  const body = {};
  if (argv.name !== undefined) {
    const name = String(argv.name).trim();
    if (!name) throw argsError("--name cannot be empty");
    body.name = name;
  }
  const mergeOptOut = parseBooleanFlag(argv.mergeOptOut, "--merge-opt-out");
  if (mergeOptOut !== undefined) body.mergeOptOut = mergeOptOut;
  if (argv.workspacePath !== undefined) {
    // Binding fields: the server requires daemonHost + workspacePath together,
    // plus bindingConfirmed, and refuses to change an existing binding (409).
    const daemonHost = argv.bindDaemonHost || project.daemonHost || argv.daemonHost;
    if (!daemonHost) {
      throw argsError("--workspace-path needs a daemon: pass --bind-daemon-host <host>");
    }
    // The path lives on `daemonHost`, which may not be this machine, so a
    // relative path cannot be resolved here.
    const workspacePath = String(argv.workspacePath).trim();
    if (!path.isAbsolute(workspacePath)) {
      throw argsError(`--workspace-path must be an absolute path on daemon ${daemonHost}`);
    }
    body.daemonHost = String(daemonHost);
    body.workspacePath = path.normalize(workspacePath);
    body.bindingConfirmed = true;
  }
  const extra = parseJsonOption(argv.jsonBody, "--json-body");
  if (extra !== undefined) {
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
      throw argsError("--json-body must be a JSON object");
    }
    Object.assign(body, extra);
  }
  if (Object.keys(body).length === 0) {
    throw argsError("Nothing to update: pass --name, --merge-opt-out, --workspace-path or --json-body");
  }
  // Same as the web Split/Merge toggle: splitting opts out every member of the
  // merged group; merging clears the opt-out on every same-name project on
  // another daemon, whichever side had opted out.
  let peers = [];
  if (mergeOptOut !== undefined) {
    const apis = await buildApis(deps);
    const all = await apis.projects.listProjects({ includeHidden: true });
    peers = mergeOptOut
      ? displayedGroup(all, project).filter((entry) => entry.id !== project.id)
      : all.filter((entry) =>
          entry.id !== project.id &&
          entry.name === project.name &&
          String(project.daemonHost ?? "").trim() &&
          String(entry.daemonHost ?? "").trim() &&
          String(entry.daemonHost).trim() !== String(project.daemonHost).trim());
  }
  const result = await sendOrPreview(http, argv, deps, "PATCH", "/api/projects", body, {
    query: projectQuery(project.id),
  });
  for (const peer of peers) {
    await sendOrPreview(http, argv, deps, "PATCH", "/api/projects", { mergeOptOut }, {
      query: projectQuery(peer.id),
    });
  }
  if (result.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(
      deps.stdout,
      peers.length > 0 ? { ...result.data, ids: [project.id, ...peers.map((peer) => peer.id)] } : result.data,
    );
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Updated project ${displayName(result.data ?? project)}`);
  if (peers.length > 0) {
    printPretty(deps.stdout, `${mergeOptOut ? "Also split" : "Also re-merged"} ${peers.length} same-name project(s):`);
    for (const peer of peers) printPretty(deps.stdout, `  ${displayName(peer)} on ${peer.daemonHost}`);
  }
  return EXIT.OK;
}

async function handleRefresh(argv, deps) {
  const project = await resolveTarget(argv, deps);
  const http = await buildHttp(deps);
  const result = await sendOrPreview(http, argv, deps, "PATCH", "/api/projects", { refresh: true }, {
    query: projectQuery(project.id),
  });
  if (result.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, result.data);
    return EXIT.OK;
  }
  const updated = result.data ?? project;
  const branch = updated.worktreeBranch ? ` branch=${updated.worktreeBranch}` : "";
  const commit = updated.lastCommit ? ` commit=${String(updated.lastCommit).slice(0, 12)}` : "";
  printPretty(deps.stdout, `Refreshed project ${displayName(updated)}${branch}${commit}`);
  return EXIT.OK;
}

async function handleDelete(argv, deps) {
  if (!argv.yes && !argv.dryRun) {
    throw argsError(
      "Refusing to delete without --yes: this stops the project's running tasks and deletes its tasks and messages, " +
        "including tasks filed under other projects; a cross-daemon merged project is deleted on every daemon " +
        "unless --daemon-host picks one",
    );
  }
  const { project, members: group } = await resolveTargetGroup(argv, deps);
  // --daemon-host targets that one copy; otherwise the whole group, like the web.
  const members = argv.daemonHost ? [project] : group;
  const http = await buildHttp(deps);
  // Sequential like the web: each daemon may clean up worktrees first. There is
  // no rollback, so stop at the first failure and say what is left.
  for (const [index, member] of members.entries()) {
    try {
      await sendOrPreview(http, argv, deps, "DELETE", "/api/projects", undefined, {
        query: projectQuery(member.id),
      });
    } catch (err) {
      if (members.length > 1) {
        const ids = (list) => list.map((entry) => entry.id).join(", ") || "none";
        err.message = `Deleted: ${ids(members.slice(0, index))}; not deleted: ${ids(members.slice(index))}. ` +
          `Failed on ${member.id} (${err.message})`;
      }
      throw err;
    }
  }
  if (argv.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(
      deps.stdout,
      members.length > 1
        ? { deleted: true, id: project.id, ids: members.map((member) => member.id) }
        : { deleted: true, id: project.id },
    );
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Deleted ${describeGroup(project, members)}`);
  return EXIT.OK;
}

async function handleReorder(argv, deps) {
  const selectors = (argv.idOrNames || []).map(String).filter(Boolean);
  if (selectors.length === 0) throw argsError("Pass at least one project id or name");
  const apis = await buildApis(deps);
  const ordered = [];
  for (const selector of selectors) {
    const project = await resolveProjectSelector(apis, selector, {
      env: deps.env,
      cwd: deps.cwd,
      daemonHost: argv.daemonHost,
    });
    if (ordered.includes(project.id)) throw argsError(`Project listed twice: ${selector}`);
    ordered.push(project.id);
  }
  // The server requires every project exactly once; keep the unlisted ones in
  // their current display order after the listed ones.
  const all = await apis.projects.listProjects({ includeHidden: true });
  const projectIds = [...ordered, ...all.map((entry) => entry.id).filter((id) => !ordered.includes(id))];
  const http = await buildHttp(deps);
  const result = await sendOrPreview(http, argv, deps, "POST", "/api/projects/reorder", { projectIds });
  if (result.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, result.data);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Reordered ${projectIds.length} projects`);
  return EXIT.OK;
}

async function handleAgents(argv, deps) {
  const project = await resolveTarget(argv, deps);
  const http = await buildHttp(deps);
  const data = await http.get(apiPath("projects", project.id, "agents"));
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  if (agents.length === 0) {
    printPretty(deps.stdout, "(no agents registered)");
    return EXIT.OK;
  }
  printPretty(deps.stdout, `${pad("NAME", 20)} ${pad("BACKEND", 12)} DESCRIPTION`);
  for (const agent of agents) {
    printPretty(deps.stdout, `${pad(agent.name, 20)} ${pad(agent.backend ?? "", 12)} ${agent.description ?? ""}`);
  }
  return EXIT.OK;
}

async function handleCollabInvite(argv, deps) {
  const project = await resolveTarget(argv, deps);
  const http = await buildHttp(deps);
  const result = await sendOrPreview(http, argv, deps, "POST", apiPath("projects", project.id, "collaboration"), undefined);
  if (result.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, result.data);
    return EXIT.OK;
  }
  const data = result.data || {};
  const inviteUrl = data.inviteUrl ?? data.invite_url ?? data.collaboration?.inviteUrl;
  const inviteToken = data.inviteToken ?? data.invite_token;
  const collaborationId = data.collaboration?.id;
  printPretty(
    deps.stdout,
    `Collaboration ${collaborationId ? `${collaborationId} ` : ""}for project ${displayName(project)}`,
  );
  if (inviteUrl) printPretty(deps.stdout, `Invite URL:   ${inviteUrl}`);
  if (inviteToken) printPretty(deps.stdout, `Invite token: ${inviteToken}`);
  return EXIT.OK;
}

/** Accept a bare invite token or an invite URL ending in /app/invite/<token>. */
/** Preview an invite (what the web /app/invite/<token> page shows) before joining. */
async function handleCollabShowInvite(argv, deps) {
  const inviteToken = parseInviteToken(argv.token);
  const http = await buildHttp(deps);
  const data = await http.get(apiPath("invitations", inviteToken));
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const collaboration = data?.collaboration ?? {};
  const members = Array.isArray(collaboration.members) ? collaboration.members : [];
  printPretty(deps.stdout, `Collaboration ${collaboration.id ?? ""} (${members.length} member${members.length === 1 ? "" : "s"})`);
  if (data?.alreadyJoined) printPretty(deps.stdout, "You have already joined this collaboration.");
  if (data?.isFull) printPretty(deps.stdout, "This collaboration is full.");
  if (data?.suggestedProjectName) {
    const note = data.suggestedProjectNameHidden ? " (a hidden project already has this name; unhide it to join with it)" : "";
    printPretty(deps.stdout, `Suggested project name: ${data.suggestedProjectName}${note}`);
  }
  const candidates = (Array.isArray(data?.candidateProjects) ? data.candidateProjects : []).filter((p) => p.canJoin);
  if (candidates.length) {
    printPretty(deps.stdout, "Projects you can join with (--into):");
    for (const project of candidates) {
      printPretty(deps.stdout, `  ${project.id}  ${project.name}${project.daemonHost ? `@${project.daemonHost}` : ""}`);
    }
  }
  printPretty(deps.stdout, `Join with: conductor project collab join ${inviteToken} (--into <project> | --create-project <name>)`);
  return EXIT.OK;
}

export function parseInviteToken(input) {
  const text = String(input ?? "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const match = url.pathname.match(/\/invite\/([^/]+)\/?$/);
      if (match) return decodeURIComponent(match[1]);
      const fromQuery = url.searchParams.get("token") || url.searchParams.get("inviteToken");
      if (fromQuery) return fromQuery;
    } catch {
      // fall through to treating it as a token
    }
    throw argsError(`Could not find an invite token in URL: ${text}`);
  }
  return text;
}

async function handleCollabJoin(argv, deps) {
  const inviteToken = parseInviteToken(argv.token);
  if (!inviteToken) throw argsError("Invite token is required");
  const hasInto = argv.into !== undefined && String(argv.into).trim() !== "";
  const hasCreate = argv.createProject !== undefined && String(argv.createProject).trim() !== "";
  if (hasInto === hasCreate) {
    throw argsError("Pass exactly one of --into <id|name> (join with an existing project) or --create-project <name>");
  }
  const body = { inviteToken };
  if (hasInto) {
    const project = await resolveTarget(argv, deps, String(argv.into));
    body.projectId = project.id;
  } else {
    body.createProjectName = String(argv.createProject).trim();
  }
  const http = await buildHttp(deps);
  const result = await sendOrPreview(http, argv, deps, "POST", "/api/collaboration/join", body);
  if (result.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, result.data);
    return EXIT.OK;
  }
  const data = result.data || {};
  printPretty(
    deps.stdout,
    `Joined collaboration ${data.collaborationId ?? data.collaboration_id ?? data.collaboration?.id ?? ""} with project ${data.projectId ?? data.project_id ?? body.projectId ?? ""}`,
  );
  return EXIT.OK;
}

async function handleCollabLeave(argv, deps) {
  const project = await resolveTarget(argv, deps);
  const http = await buildHttp(deps);
  const raw = await fetchRawProject(http, project.id);
  const collaborationId = raw.collaborationId ?? raw.collaboration_id ?? raw.collaboration?.id ?? null;
  if (!collaborationId) {
    throw argsError(`Project ${displayName(project)} is not in a collaboration`);
  }
  const result = await sendOrPreview(
    http, argv, deps, "DELETE", apiPath("collaboration", collaborationId, "members", "me"), undefined,
  );
  if (result.dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, { left: true, collaborationId, projectId: project.id });
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Left collaboration ${collaborationId} (project ${displayName(project)})`);
  return EXIT.OK;
}

// ---- task labels (project.metadata.taskLabels, see web/src/lib/projects/task-labels.ts)

const TASK_LABELS_KEY = "taskLabels";
const MAX_TASK_LABEL_NAME_CHARS = 32;
const MAX_TASK_LABELS_PER_PROJECT = 50;

function normalizeLabelName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_TASK_LABEL_NAME_CHARS);
}

function labelKey(name) {
  return normalizeLabelName(name).toLowerCase();
}

function metadataRecord(project) {
  const metadata = project?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

function readLabels(project) {
  const raw = metadataRecord(project)[TASK_LABELS_KEY];
  if (!Array.isArray(raw)) return [];
  const labels = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) continue;
    const name = normalizeLabelName(entry.name);
    if (!name || seen.has(entry.id)) continue;
    seen.add(entry.id);
    labels.push({ id: entry.id, name });
  }
  return labels;
}

function canonicalRemote(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";
  const slash = normalized.indexOf("/");
  if (slash < 0) return normalized;
  const host = normalized.slice(0, slash);
  const canonicalHost = host === "github.com" || host.startsWith("github-") || host.startsWith("github.com-")
    ? "github.com"
    : host;
  return `${canonicalHost}${normalized.slice(slash)}`;
}

/** Mirror of `canMergeProjectsByFields` in web/src/lib/projects/grouping.ts. */
function canMerge(a, b) {
  if (a.name !== b.name) return false;
  // SDK `Project`s keep these fields under `raw`; raw API rows have them inline.
  if (groupField(a, "mergeOptOut") === true || groupField(b, "mergeOptOut") === true) return false;
  const aHost = String(a.daemonHost ?? "").trim();
  const bHost = String(b.daemonHost ?? "").trim();
  if (!aHost || !bHost || aHost === bHost) return false;
  const aUrl = canonicalRemote(groupField(a, "gitRemoteUrl"));
  const bUrl = canonicalRemote(groupField(b, "gitRemoteUrl"));
  return !(aUrl && bUrl && aUrl !== bUrl);
}

function groupField(project, key) {
  return project[key] ?? project.raw?.[key];
}

function isHiddenProject(project) {
  return typeof project.hidden === "boolean" ? project.hidden : Boolean(project.hiddenAt ?? project.hidden_at);
}

/**
 * The merged group the web project list shows `target` in: mirror of
 * `computeProjectGroups` (web/src/features/projects/utils/project-groups.ts)
 * over the visible projects, or over all of them when `target` is hidden
 * (only listed once hidden projects are revealed).
 */
function displayedGroup(all, target) {
  const hidden = isHiddenProject(target);
  const list = all.filter((entry) => hidden || !isHiddenProject(entry) || entry.id === target.id);
  const grouped = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const anchor = list[i];
    if (grouped.has(anchor.id)) continue;
    const members = [anchor];
    for (const candidate of list.slice(i + 1)) {
      if (!grouped.has(candidate.id) && canMerge(anchor, candidate)) members.push(candidate);
    }
    for (const member of members) grouped.add(member.id);
    if (members.some((member) => member.id === target.id)) return members;
  }
  return [target];
}

/** Mirror of `expandMergedProjectGroup`: every project merging with any seed, hidden included. */
function expandGroup(seeds, all) {
  const expanded = all.filter((candidate) =>
    seeds.some((seed) => seed.id === candidate.id || canMerge(seed, candidate)),
  );
  const ids = new Set(expanded.map((entry) => entry.id));
  return [...expanded, ...seeds.filter((seed) => !ids.has(seed.id))];
}

async function resolveTargetGroup(argv, deps) {
  const project = await resolveTarget(argv, deps);
  const apis = await buildApis(deps);
  const all = await apis.projects.listProjects({ includeHidden: true });
  return { project, all, members: displayedGroup(all, project) };
}

function describeGroup(project, members) {
  return members.length > 1
    ? `merged project ${project.name ?? project.id} on ${members.length} daemons`
    : `project ${displayName(project)}`;
}

/**
 * Labels are shared across a cross-daemon merged group: reads union every
 * member and writes fan out to every member (including hidden ones), same as
 * the web settings page.
 */
async function loadLabelGroup(argv, deps) {
  const project = await resolveTarget(argv, deps, argv.project);
  const http = await buildHttp(deps);
  const all = await listRawProjects(http);
  const seed = all.find((entry) => entry.id === project.id);
  if (!seed) {
    const err = new Error(`Project not found: ${project.id}`);
    err.statusCode = 404;
    throw err;
  }
  const expanded = expandGroup(displayedGroup(all, seed), all);
  const members = [seed, ...expanded.filter((entry) => entry.id !== seed.id)];
  const labels = [];
  const seen = new Set();
  for (const member of members) {
    for (const label of readLabels(member)) {
      if (seen.has(label.id)) continue;
      seen.add(label.id);
      labels.push(label);
    }
  }
  return { http, seed, members, labels };
}

async function writeLabels(argv, deps, group, next) {
  const bodies = group.members.map((member) => ({
    member,
    body: {
      metadata: {
        ...metadataRecord(member),
        [TASK_LABELS_KEY]: next.map((label) => ({ id: label.id, name: label.name })),
      },
    },
  }));
  if (argv.dryRun) {
    for (const { member, body } of bodies) {
      await sendOrPreview(group.http, argv, deps, "PATCH", "/api/projects", body, { query: projectQuery(member.id) });
    }
    return false;
  }
  const failures = [];
  for (const { member, body } of bodies) {
    try {
      await group.http.patch("/api/projects", body, { query: projectQuery(member.id) });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    if (failures.length === bodies.length) throw failures[0];
    const err = new Error(
      `Saved on ${bodies.length - failures.length} of ${bodies.length} merged projects: ${failures[0].message}`,
    );
    err.statusCode = failures[0].statusCode;
    err.details = failures[0].details;
    throw err;
  }
  return true;
}

function findLabel(labels, selector) {
  const text = String(selector ?? "");
  const byId = labels.find((label) => label.id === text);
  if (byId) return byId;
  const byName = labels.find((label) => labelKey(label.name) === labelKey(text));
  if (byName) return byName;
  const err = new Error(`No label matching '${text}'`);
  err.statusCode = 404;
  throw err;
}

function printLabels(argv, deps, labels) {
  if (argv.json) {
    printJson(deps.stdout, labels);
    return;
  }
  if (labels.length === 0) {
    printPretty(deps.stdout, "(no labels)");
    return;
  }
  printPretty(deps.stdout, `${pad("ID", 38)} NAME`);
  for (const label of labels) printPretty(deps.stdout, `${pad(label.id, 38)} ${label.name}`);
}

async function handleLabelsList(argv, deps) {
  const group = await loadLabelGroup({ ...argv, project: argv.idOrName ?? argv.project }, deps);
  printLabels(argv, deps, group.labels);
  return EXIT.OK;
}

async function handleLabelsAdd(argv, deps) {
  const name = normalizeLabelName(String(argv.name ?? ""));
  if (!name) throw argsError("Label name cannot be empty");
  const group = await loadLabelGroup(argv, deps);
  if (group.labels.length >= MAX_TASK_LABELS_PER_PROJECT) {
    throw argsError(`A project can have at most ${MAX_TASK_LABELS_PER_PROJECT} labels`);
  }
  if (group.labels.some((label) => labelKey(label.name) === labelKey(name))) {
    throw argsError(`Label "${name}" already exists for this project`);
  }
  const label = { id: randomUUID(), name };
  const next = [...group.labels, label];
  if (!(await writeLabels(argv, deps, group, next))) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, label);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Added label ${name} (${label.id})`);
  return EXIT.OK;
}

async function handleLabelsRename(argv, deps) {
  const name = normalizeLabelName(String(argv.newName ?? ""));
  if (!name) throw argsError("Label name cannot be empty");
  const group = await loadLabelGroup(argv, deps);
  const current = findLabel(group.labels, argv.label);
  if (group.labels.some((label) => label.id !== current.id && labelKey(label.name) === labelKey(name))) {
    throw argsError(`Label "${name}" already exists for this project`);
  }
  const next = group.labels.map((label) => (label.id === current.id ? { ...label, name } : label));
  if (!(await writeLabels(argv, deps, group, next))) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, { id: current.id, name });
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Renamed label ${current.name} -> ${name}`);
  return EXIT.OK;
}

async function handleLabelsRemove(argv, deps) {
  const group = await loadLabelGroup(argv, deps);
  const current = findLabel(group.labels, argv.label);
  const next = group.labels.filter((label) => label.id !== current.id);
  if (!(await writeLabels(argv, deps, group, next))) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, { removed: true, ...current });
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Removed label ${current.name} (${current.id})`);
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
        (cmd) => cmd
          .positional("idOrName", { type: "string" })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
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
          .option("daemon-host", { type: "string", describe: "Daemon hostname for binding (default: this machine's daemon name)" })
          .option("create-workspace", { type: "boolean", default: false, describe: "Create the workspace path on the daemon if it does not exist" })
          .option("default", { type: "boolean", default: false, describe: "Create the user's default project" })
          .option("client-request-id", { type: "string", describe: "Idempotency key" }),
        async (argv) => {
          exitCode = await handleCreate(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "set-default <idOrName>",
        "Set the user's default project",
        (cmd) => cmd
          .positional("idOrName", { type: "string", demandOption: true })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
        async (argv) => {
          exitCode = await handleSetDefault(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "hide <idOrName>",
        "Hide a project from default listings (on every daemon of a merged project)",
        (cmd) => cmd
          .positional("idOrName", { type: "string", demandOption: true })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
        async (argv) => {
          exitCode = await handleSetHidden(argv, { ...handlerDeps, configFile: argv.configFile }, true);
        },
      )
      .command(
        "unhide <idOrName>",
        "Unhide a previously hidden project (on every daemon of a merged project)",
        (cmd) => cmd
          .positional("idOrName", { type: "string", demandOption: true })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
        async (argv) => {
          exitCode = await handleSetHidden(argv, { ...handlerDeps, configFile: argv.configFile }, false);
        },
      )
      .command(
        "update <idOrName>",
        "Update a project's name, merge opt-out or (unbound projects only) workspace binding",
        (cmd) => cmd
          .positional("idOrName", { type: "string", demandOption: true })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" })
          .option("name", { type: "string", describe: "New project name" })
          .option("merge-opt-out", {
            type: "string",
            describe: "true splits its cross-daemon merged group (every member), false merges it with same-name projects on other daemons",
          })
          .option("workspace-path", { type: "string", describe: "Bind an unbound project to this workspace path" })
          .option("bind-daemon-host", { type: "string", describe: "Daemon for --workspace-path (defaults to the project's daemon)" })
          .option("json-body", { type: "string", describe: "Extra raw PATCH fields as a JSON object (merged last)" }),
        async (argv) => {
          exitCode = await handleUpdate(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "refresh <idOrName>",
        "Re-validate the project's binding with its daemon and refresh git snapshot fields",
        (cmd) => cmd
          .positional("idOrName", { type: "string", demandOption: true })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
        async (argv) => {
          exitCode = await handleRefresh(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "delete <idOrName>",
        "Delete a project, on every daemon if merged (stops its running tasks and deletes its tasks); requires --yes",
        (cmd) => cmd
          .positional("idOrName", { type: "string", demandOption: true })
          .option("daemon-host", { type: "string", describe: "Delete only the copy on this daemon, not the whole merged group" })
          .option("yes", { type: "boolean", default: false, describe: "Confirm the deletion" }),
        async (argv) => {
          exitCode = await handleDelete(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "reorder <idOrNames..>",
        "Reorder projects: the listed projects go first, the rest keep their current order",
        (cmd) => cmd
          .positional("idOrNames", { type: "string", array: true })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
        async (argv) => {
          exitCode = await handleReorder(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "agents [idOrName]",
        "List the agents a project registers (usable when creating multi-agent tasks)",
        (cmd) => cmd
          .positional("idOrName", { type: "string" })
          .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
        async (argv) => {
          exitCode = await handleAgents(argv, { ...handlerDeps, configFile: argv.configFile });
        },
      )
      .command(
        "collab",
        "Project collaboration: invite, join, leave",
        (cmd) => cmd
          .command(
            "invite [idOrName]",
            "Start (or reuse) a collaboration for a project and print its invite link",
            (sub) => sub
              .positional("idOrName", { type: "string" })
              .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
            async (argv) => {
              exitCode = await handleCollabInvite(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "join <token>",
            "Join a collaboration from an invite token or invite URL",
            (sub) => sub
              .positional("token", { type: "string", describe: "Invite token or invite URL" })
              .option("into", { type: "string", describe: "Existing project (id or name) to join with" })
              .option("create-project", { type: "string", describe: "Create a new project with this name to join with" })
              .option("daemon-host", { type: "string", describe: "Disambiguate --into across daemons" }),
            async (argv) => {
              exitCode = await handleCollabJoin(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "show-invite <token>",
            "Preview a collaboration invite before joining",
            (sub) => sub.positional("token", { type: "string", describe: "Invite token or invite URL" }),
            async (argv) => {
              exitCode = await handleCollabShowInvite(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "leave <idOrName>",
            "Leave the collaboration a project belongs to",
            (sub) => sub
              .positional("idOrName", { type: "string", demandOption: true })
              .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
            async (argv) => {
              exitCode = await handleCollabLeave(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .demandCommand(1),
      )
      .command(
        "labels",
        "Task label definitions (shared across a cross-daemon merged project group)",
        (cmd) => cmd
          .command(
            "list [idOrName]",
            "List task labels",
            (sub) => sub
              .positional("idOrName", { type: "string" })
              .option("daemon-host", { type: "string", describe: "Disambiguate same-name projects across daemons" }),
            async (argv) => {
              exitCode = await handleLabelsList(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "add <name>",
            "Add a task label (target project via --project)",
            (sub) => sub
              .positional("name", { type: "string" })
              .option("daemon-host", { type: "string", describe: "Disambiguate --project across daemons" }),
            async (argv) => {
              exitCode = await handleLabelsAdd(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "rename <label> <newName>",
            "Rename a task label (label id or name)",
            (sub) => sub
              .positional("label", { type: "string" })
              .positional("newName", { type: "string" })
              .option("daemon-host", { type: "string", describe: "Disambiguate --project across daemons" }),
            async (argv) => {
              exitCode = await handleLabelsRename(argv, { ...handlerDeps, configFile: argv.configFile });
            },
          )
          .command(
            "remove <label>",
            "Remove a task label (label id or name)",
            (sub) => sub
              .positional("label", { type: "string" })
              .option("daemon-host", { type: "string", describe: "Disambiguate --project across daemons" }),
            async (argv) => {
              exitCode = await handleLabelsRemove(argv, { ...handlerDeps, configFile: argv.configFile });
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
