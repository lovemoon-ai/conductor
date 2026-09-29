/**
 * Write / remote-control verbs for `conductor daemon`, mirroring the web
 * frontend's daemon panel (AI manager, custom commands, update button, resume
 * sessions) and daemon sharing (DaemonSharingCard, /app/daemon-share/[token]).
 *
 *   restart <host>                       POST   /api/agents/:host/restart
 *   upgrade <host> [--status] [--wait]   POST|GET /api/agents/:host/update
 *   sessions <host>                      GET    /api/agents/:host/sessions
 *   accounts <host>                      GET    /api/ai-manager/accounts?agentHost=
 *   switch-account <host> <name>         POST   /api/ai-manager/switch
 *   commands list <host>                 GET    /api/agents/:host/custom-commands
 *   commands run <host> <key> [--wait]   POST   /api/agents/:host/custom-commands/run
 *   commands status <host> <runId>       GET    /api/agents/:host/custom-commands/runs/:runId
 *   share create <host>                  POST   /api/daemon-shares
 *   share list [--host h]                GET    /api/daemon-shares
 *   share revoke <id>                    DELETE /api/daemon-shares/:id
 *   share show-invite <token|url>        GET    /api/daemon-shares/invitations/:token
 *   share accept <token|url>             POST   /api/daemon-shares/accept/:token
 */

import { apiPath, argsError, buildHttp, sendOrPreview } from "./backend-http.js";
import { EXIT, pad, printJson, printPretty } from "./entity-helpers.js";

export const DAEMON_REMOTE_VERBS = [
  "restart",
  "upgrade",
  "sessions",
  "accounts",
  "switch-account",
  "commands",
  "share",
];

// The frontend's SDK client gives ai-manager round trips 45s (the server waits
// up to 30s for the daemon on a switch).
const AI_MANAGER_TIMEOUT_MS = 45_000;
// Same cadence as UpdateDaemonButton / CustomCommandsPanel.
const POLL_INTERVAL_MS = 2_000;
// UpdateDaemonButton gives install + verify + restart 15 minutes.
const UPGRADE_WAIT_TIMEOUT_MS = 15 * 60_000;
const COMMAND_WAIT_TIMEOUT_MS = 60 * 60_000;

export function printTable(stream, header, rows) {
  const widths = header
    .slice(0, -1)
    .map((title, i) => Math.max(title.length, ...rows.map((row) => String(row[i] ?? "").length)));
  for (const row of [header, ...rows]) {
    printPretty(stream, row.map((cell, i) => (i < widths.length ? pad(cell, widths[i]) : (cell ?? ""))).join("  "));
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function oneLine(text, max = 80) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Accept a bare invite token or a full `.../app/daemon-share/<token>` URL. */
export function extractInviteToken(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw argsError("invite token or URL is required");
  const match = raw.match(/\/daemon-share\/([^/?#]+)/);
  if (match) return decodeURIComponent(match[1]);
  if (/^[a-z]+:\/\//i.test(raw)) throw argsError(`not a daemon share invite URL: ${raw}`);
  return raw;
}

// ---------------------------------------------------------------- restart

async function handleRestart(argv, deps) {
  const http = await buildHttp(deps);
  const body = argv.targetVersion ? { targetVersion: argv.targetVersion } : {};
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", apiPath("agents", argv.host, "restart"), body);
  if (dryRun) return EXIT.OK;
  if (argv.json) printJson(deps.stdout, data);
  else printPretty(deps.stdout, `Restart requested for ${argv.host}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- upgrade

function describeUpgrade(status) {
  if (!status || typeof status !== "object") return "(no update status)";
  const parts = [`status: ${status.status ?? "unknown"}`];
  if (status.phase) parts.push(`phase: ${status.phase}`);
  if (status.fromVersion || status.toVersion) {
    parts.push(`version: ${status.fromVersion ?? "?"} -> ${status.toVersion ?? "?"}`);
  }
  if (status.message) parts.push(`message: ${status.message}`);
  if (status.error) parts.push(`error: ${status.error}`);
  if (status.logPath) parts.push(`log: ${status.logPath}`);
  return parts.join("\n");
}

function upgradeExitCode(status) {
  return status?.status === "failed" ? EXIT.GENERIC : EXIT.OK;
}

async function waitForUpgrade(http, argv, deps, initial) {
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || Date.now;
  const path = apiPath("agents", argv.host, "update");
  const deadline = now() + (argv.waitTimeout ?? UPGRADE_WAIT_TIMEOUT_MS / 1000) * 1000;
  let last = initial;
  let lastLine = "";
  const progress = (status) => {
    if (argv.json) return;
    const line = [status?.status, status?.phase, status?.message].filter(Boolean).join(" · ");
    if (line && line !== lastLine) {
      deps.stderr.write(`${line}\n`);
      lastLine = line;
    }
  };
  if (last) progress(last);
  // The daemon restarts itself midway through a successful update, so a failed
  // poll means "not answering right now", not "the update failed".
  while (!last || last.status === "running") {
    if (now() > deadline) {
      throw new Error(`Lost track of the daemon update: ${argv.host} did not reach a final state in time`);
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      last = await http.get(path);
      progress(last);
    } catch {
      if (!argv.json && lastLine !== "(daemon not answering, likely restarting)") {
        lastLine = "(daemon not answering, likely restarting)";
        deps.stderr.write(`${lastLine}\n`);
      }
    }
  }
  return last;
}

async function handleUpgrade(argv, deps) {
  const http = await buildHttp(deps);
  const path = apiPath("agents", argv.host, "update");
  let status;
  if (argv.status) {
    status = await http.get(path);
  } else {
    const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", path, undefined);
    if (dryRun) return EXIT.OK;
    status = data;
  }
  if (argv.wait) status = await waitForUpgrade(http, argv, deps, status);
  if (argv.json) printJson(deps.stdout, status);
  else printPretty(deps.stdout, describeUpgrade(status));
  return argv.wait || argv.status ? upgradeExitCode(status) : EXIT.OK;
}

// ---------------------------------------------------------------- sessions

async function handleSessions(argv, deps) {
  const http = await buildHttp(deps);
  const backends = (argv.backend ?? [])
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const data = await http.get(apiPath("agents", argv.host, "sessions"), {
    query: {
      backends: backends.length > 0 ? backends.join(",") : undefined,
      limit: argv.limit,
    },
  });
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const sessions = data?.sessions ?? [];
  if (sessions.length === 0) {
    printPretty(deps.stdout, "(no resumable sessions)");
  } else {
    printTable(deps.stdout, ["BACKEND", "SESSION", "UPDATED", "TASK", "CWD", "TITLE"], sessions.map((s) => [
      s.backend ?? "",
      s.session_id ?? "",
      s.updated_at ?? "",
      s.linked_task_id ?? "",
      s.cwd ?? "",
      oneLine(s.title || s.first_user_message || ""),
    ]));
  }
  for (const error of data?.errors ?? []) {
    deps.stderr.write(`warning: ${error.backend}: ${error.message}\n`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------- accounts

async function handleAccounts(argv, deps) {
  const http = await buildHttp(deps);
  const data = await http.get("/api/ai-manager/accounts", {
    query: { agentHost: argv.host },
    timeoutMs: AI_MANAGER_TIMEOUT_MS,
  });
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const accounts = data?.accounts ?? [];
  if (accounts.length === 0) {
    printPretty(deps.stdout, "(no codex accounts)");
    return EXIT.OK;
  }
  printTable(deps.stdout, ["", "NAME", "EMAIL", "PLAN", "LAST REFRESH"], accounts.map((a) => [
    a.isCurrent ? "*" : "",
    a.name ?? "",
    a.email ?? "",
    a.planType ?? "",
    a.lastRefresh ?? "",
  ]));
  return EXIT.OK;
}

async function handleSwitchAccount(argv, deps) {
  const name = argv.account ?? argv.name;
  if (!name) throw argsError("account name is required (positional <name> or --account)");
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http,
    argv,
    deps,
    "POST",
    "/api/ai-manager/switch",
    { agentHost: argv.host, name },
    { timeoutMs: AI_MANAGER_TIMEOUT_MS },
  );
  if (dryRun) return EXIT.OK;
  if (argv.json) printJson(deps.stdout, data);
  else {
    const from = data?.previousName ? ` (was ${data.previousName})` : "";
    printPretty(deps.stdout, `Switched codex account on ${argv.host} to ${data?.newName ?? name}${from}`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------- custom commands

async function handleCommandsList(argv, deps) {
  const http = await buildHttp(deps);
  const data = await http.get(apiPath("agents", argv.host, "custom-commands"));
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const commands = data?.commands ?? [];
  if (commands.length === 0) {
    printPretty(deps.stdout, "(no custom commands configured)");
    return EXIT.OK;
  }
  printTable(deps.stdout, ["KEY", "STATE", "RUN ID"], commands.map((c) => [
    c.key,
    c.running ? "running" : "idle",
    c.runId ?? "",
  ]));
  return EXIT.OK;
}

function printRunStatus(stream, run) {
  const lines = [`run: ${run?.runId ?? ""}`, `command: ${run?.key ?? ""}`, `status: ${run?.status ?? "unknown"}`];
  if (run?.exitCode != null) lines.push(`exit code: ${run.exitCode}`);
  if (run?.signal) lines.push(`signal: ${run.signal}`);
  if (run?.error) lines.push(`error: ${run.error}`);
  printPretty(stream, lines.join("\n"));
  if (run?.stdoutTail) printPretty(stream, `--- stdout (tail) ---\n${run.stdoutTail.replace(/\n$/, "")}`);
  if (run?.stderrTail) printPretty(stream, `--- stderr (tail) ---\n${run.stderrTail.replace(/\n$/, "")}`);
}

function runExitCode(run) {
  return run?.status === "failed" ? EXIT.GENERIC : EXIT.OK;
}

async function handleCommandsRun(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(
    http,
    argv,
    deps,
    "POST",
    apiPath("agents", argv.host, "custom-commands", "run"),
    { key: argv.key },
  );
  if (dryRun) return EXIT.OK;
  if (!argv.wait) {
    if (argv.json) printJson(deps.stdout, data);
    else {
      printPretty(deps.stdout, `${data?.started === false ? "Already running" : "Started"} ${data?.key ?? argv.key} (run ${data?.runId ?? "?"}, ${data?.status ?? "running"})`);
      if (data?.runId) printPretty(deps.stdout, `Follow with: conductor daemon commands status ${argv.host} ${data.runId}`);
    }
    return runExitCode(data);
  }
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || Date.now;
  const deadline = now() + (argv.waitTimeout ?? COMMAND_WAIT_TIMEOUT_MS / 1000) * 1000;
  let run = data;
  const statusPath = apiPath("agents", argv.host, "custom-commands", "runs", data?.runId ?? "");
  while (run?.status === "running") {
    if (!data?.runId) throw new Error("server did not return a runId to wait on");
    if (now() > deadline) throw new Error(`timed out waiting for run ${data.runId}`);
    await sleep(POLL_INTERVAL_MS);
    run = await http.get(statusPath);
  }
  if (argv.json) printJson(deps.stdout, run);
  else printRunStatus(deps.stdout, run);
  return runExitCode(run);
}

async function handleCommandsStatus(argv, deps) {
  const http = await buildHttp(deps);
  const run = await http.get(apiPath("agents", argv.host, "custom-commands", "runs", argv.runId));
  if (argv.json) printJson(deps.stdout, run);
  else printRunStatus(deps.stdout, run);
  return EXIT.OK;
}

// ---------------------------------------------------------------- sharing

async function handleShareCreate(argv, deps) {
  const http = await buildHttp(deps);
  const body = { daemonHost: argv.host };
  if (argv.workspaceRoot) body.workspaceRoot = argv.workspaceRoot;
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", "/api/daemon-shares", body);
  if (dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Created share ${data?.id} for ${data?.ownerDaemonHost ?? argv.host}`);
  if (data?.expiresAt) printPretty(deps.stdout, `Invite expires: ${data.expiresAt}`);
  printPretty(deps.stdout, `Invite link: ${data?.inviteUrl ?? ""}`);
  return EXIT.OK;
}

async function handleShareList(argv, deps) {
  const http = await buildHttp(deps);
  const data = await http.get("/api/daemon-shares", { query: { daemonHost: argv.host } });
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const shares = data?.shares ?? [];
  if (shares.length === 0) {
    printPretty(deps.stdout, "(no active shares)");
    return EXIT.OK;
  }
  printTable(deps.stdout, ["ID", "DAEMON", "STATUS", "GRANTEE", "GUEST HOST", "EXPIRES", "INVITE"], shares.map((s) => [
    s.id,
    s.ownerDaemonHost ?? "",
    s.status ?? "",
    s.granteeLabel ?? "",
    s.guestHost ?? "",
    s.status === "pending" ? (s.expiresAt ?? "") : "",
    s.status === "pending" ? (s.inviteUrl ?? "") : "",
  ]));
  return EXIT.OK;
}

async function handleShareRevoke(argv, deps) {
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "DELETE", apiPath("daemon-shares", argv.id), undefined);
  if (dryRun) return EXIT.OK;
  if (argv.json) printJson(deps.stdout, data);
  else printPretty(deps.stdout, data?.alreadyRevoked ? `Share ${argv.id} was already revoked` : `Revoked share ${argv.id}`);
  return EXIT.OK;
}

async function handleShareShowInvite(argv, deps) {
  const token = extractInviteToken(argv.token);
  const http = await buildHttp(deps);
  const data = await http.get(apiPath("daemon-shares", "invitations", token));
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  const lines = [
    `owner: ${data?.ownerLabel ?? ""}`,
    `daemon: ${data?.ownerDaemonHost ?? ""}`,
    `status: ${data?.status ?? ""}${data?.isSelf ? " (your own daemon)" : ""}`,
  ];
  if (data?.workspaceRoot) lines.push(`workspace root: ${data.workspaceRoot}`);
  if (data?.expiresAt) lines.push(`expires: ${data.expiresAt}`);
  if (data?.guestHost) lines.push(`guest host: ${data.guestHost}`);
  printPretty(deps.stdout, lines.join("\n"));
  return EXIT.OK;
}

async function handleShareAccept(argv, deps) {
  const token = extractInviteToken(argv.token);
  const http = await buildHttp(deps);
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", apiPath("daemon-shares", "accept", token), {});
  if (dryRun) return EXIT.OK;
  if (argv.json) printJson(deps.stdout, data);
  else printPretty(deps.stdout, `Accepted. The shared machine appears as ${data?.guestHost ?? "(unknown)"}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- registration

const hostPositional = (cmd) => cmd.positional("host", { type: "string", describe: "Daemon host name" });

/** Register the verbs on the `conductor daemon` yargs instance. */
export function registerDaemonRemoteCommands(y, run) {
  return y
    .command(
      "restart <host>",
      "Restart a daemon (it reconnects on its own)",
      (cmd) => hostPositional(cmd)
        .option("target-version", { type: "string", describe: "'latest' or a semver to restart onto" }),
      run(handleRestart),
    )
    .command(
      "upgrade <host>",
      "Upgrade the conductor CLI on a daemon and restart it",
      (cmd) => hostPositional(cmd)
        .option("status", { type: "boolean", default: false, describe: "Only show the current/last upgrade run" })
        .option("wait", { type: "boolean", default: false, describe: "Poll until the upgrade completes or fails" })
        .option("wait-timeout", { type: "number", describe: "Seconds to wait with --wait (default 900)" }),
      run(handleUpgrade),
    )
    .command(
      "sessions <host>",
      "List resumable AI sessions (claude/codex/...) on a daemon",
      (cmd) => hostPositional(cmd)
        .option("backend", { type: "array", string: true, describe: "Only these backends (repeat or comma-separate)" })
        .option("limit", { type: "number", describe: "Max sessions (1-200)" }),
      run(handleSessions),
    )
    .command(
      "accounts <host>",
      "List the codex accounts stored on a daemon (* = current)",
      hostPositional,
      run(handleAccounts),
    )
    .command(
      "switch-account <host> [name]",
      "Switch the active codex account on a daemon",
      (cmd) => hostPositional(cmd)
        .positional("name", { type: "string", describe: "Account name (see `daemon accounts`)" })
        .option("account", { type: "string", describe: "Account name (alternative to the positional)" }),
      run(handleSwitchAccount),
    )
    .command(
      "commands",
      "List, run and inspect a daemon's custom commands",
      (cmd) => cmd
        .command("list <host>", "List custom commands configured on a daemon", hostPositional, run(handleCommandsList))
        .command(
          "run <host> <key>",
          "Start a custom command",
          (sub) => hostPositional(sub)
            .positional("key", { type: "string", describe: "Command key (see `commands list`)" })
            .option("wait", { type: "boolean", default: false, describe: "Poll until the run finishes and print its output" })
            .option("wait-timeout", { type: "number", describe: "Seconds to wait with --wait (default 3600)" }),
          run(handleCommandsRun),
        )
        .command(
          "status <host> <runId>",
          "Show a custom command run's status, exit code and output tail",
          (sub) => hostPositional(sub).positional("runId", { type: "string" }),
          run(handleCommandsStatus),
        )
        .demandCommand(1),
    )
    .command(
      "share",
      "Share a daemon with another user, or accept a share invite",
      (cmd) => cmd
        .command(
          "create <host>",
          "Create an invite link for one of your online daemons",
          (sub) => hostPositional(sub)
            .option("workspace-root", { type: "string", describe: "Restrict the guest to this directory" }),
          run(handleShareCreate),
        )
        .command(
          "list",
          "List the live shares of your daemons",
          (sub) => sub.option("host", { type: "string", describe: "Only shares of this daemon" }),
          run(handleShareList),
        )
        .command(
          "revoke <id>",
          "Revoke a share (as owner or grantee)",
          (sub) => sub.positional("id", { type: "string" }),
          run(handleShareRevoke),
        )
        .command(
          "show-invite <token>",
          "Show what an invite token/link grants",
          (sub) => sub.positional("token", { type: "string", describe: "Invite token or full invite URL" }),
          run(handleShareShowInvite),
        )
        .command(
          "accept <token>",
          "Accept a daemon share invite",
          (sub) => sub.positional("token", { type: "string", describe: "Invite token or full invite URL" }),
          run(handleShareAccept),
        )
        .demandCommand(1),
    );
}
