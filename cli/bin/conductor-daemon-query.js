/**
 * conductor daemon list|tools|quota — read-only queries about daemons.
 *
 *   list [--all]                          Online daemons, CLI version, AI backends
 *   tools <host>                          AI tools installed on a daemon + network
 *   quota <host> [--tool t] [--refresh]   Usage windows / balance per AI tool
 *
 * Dispatched from conductor-daemon.js before any daemon startup logic.
 */

import process from "node:process";

import yargs from "yargs/yargs";

import { EXIT, buildApis, pad, printJson, printPretty, reportError } from "../src/entity-helpers.js";

export const DAEMON_QUERY_VERBS = new Set(["list", "tools", "quota"]);

// Ephemeral per-task `conductor fire` processes also register as agents.
const FIRE_HOST_PREFIX = "conductor-fire-";

const WINDOW_LABELS = { fiveHour: "5h", weekly: "weekly", weeklySonnet: "weekly-sonnet" };

function printTable(stream, header, rows) {
  const widths = header
    .slice(0, -1)
    .map((title, i) => Math.max(title.length, ...rows.map((row) => String(row[i]).length)));
  for (const row of [header, ...rows]) {
    printPretty(stream, row.map((cell, i) => (i < widths.length ? pad(cell, widths[i]) : cell)).join("  "));
  }
}

function formatReset(window) {
  if (typeof window.resetAt !== "number") return window.resetOnDate ?? "";
  const date = new Date(window.resetAt * 1000);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function formatQuota(quota) {
  if (!quota || typeof quota !== "object") return "";
  if (quota.error) {
    // Provider errors can embed multi-line response bodies; --json keeps the full text.
    const text = String(quota.error).replace(/\s+/g, " ").trim();
    return `error: ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
  }
  const parts = [];
  for (const [key, window] of Object.entries(quota)) {
    // Copilot's `primary` duplicates one of its named windows.
    if (key === "primary" || typeof window?.usedPercent !== "number") continue;
    const reset = formatReset(window);
    parts.push(`${WINDOW_LABELS[key] ?? key} ${Math.round(window.usedPercent)}% used${reset ? ` (resets ${reset})` : ""}`);
  }
  if (quota.credits?.unlimited) parts.push("credits unlimited");
  else if (quota.credits?.balance != null) parts.push(`credits ${quota.credits.balance}`);
  if (quota.primaryBalance) {
    parts.push(`balance ${quota.primaryBalance.totalBalance} ${quota.primaryBalance.currency}`);
  }
  if (quota.overage?.status) {
    const reason = quota.overage.disabledReason ? ` (${quota.overage.disabledReason})` : "";
    parts.push(`overage ${quota.overage.status}${reason}`);
  }
  return parts.join(" · ") || "(no usage data)";
}

async function handleList(argv, deps) {
  const { apiClient } = await buildApis(deps);
  const agents = (await apiClient.listAgents())
    .filter((agent) => argv.all || !String(agent.host).startsWith(FIRE_HOST_PREFIX));
  if (argv.json) {
    printJson(deps.stdout, agents);
    return EXIT.OK;
  }
  if (agents.length === 0) {
    printPretty(deps.stdout, "(no daemons online)");
    return EXIT.OK;
  }
  printTable(deps.stdout, ["HOST", "VERSION", "BACKENDS"], agents.map((agent) => [
    agent.shared ? `${agent.host} (shared by ${agent.ownerLabel})` : agent.host,
    agent.version ?? "",
    (agent.supportedBackends ?? []).join(","),
  ]));
  return EXIT.OK;
}

async function handleTools(argv, deps) {
  const { apiClient } = await buildApis(deps);
  const status = await apiClient.getAiManagerStatus(argv.host);
  if (argv.json) {
    printJson(deps.stdout, status);
    return EXIT.OK;
  }
  const install = status?.install ?? {};
  const network = status?.network ?? {};
  printTable(deps.stdout, ["TOOL", "INSTALLED", "VERSION", "NETWORK"], Object.keys(install).map((tool) => {
    const net = network[tool];
    const reach = !install[tool]?.installed || !net
      ? ""
      : net.reachable
        ? `ok${net.latencyMs != null ? ` (${net.latencyMs}ms)` : ""}`
        : `unreachable${net.error ? `: ${net.error}` : ""}`;
    return [tool, install[tool]?.installed ? "yes" : "no", install[tool]?.version ?? "", reach];
  }));
  return EXIT.OK;
}

async function handleQuota(argv, deps) {
  const { apiClient } = await buildApis(deps);
  const quota = await apiClient.getAiManagerQuota(argv.host, {
    tool: argv.tool,
    forceRefresh: argv.refresh,
  });
  if (argv.json) {
    printJson(deps.stdout, quota);
    return EXIT.OK;
  }
  const { external, ...tools } = quota ?? {};
  const entries = [...Object.entries(tools), ...Object.entries(external ?? {})];
  if (entries.length === 0) {
    printPretty(deps.stdout, "(no quota data)");
    return EXIT.OK;
  }
  printTable(deps.stdout, ["TOOL", "SOURCE", "QUOTA"], entries.map(([tool, entry]) => [
    tool,
    entry?.source ?? "",
    formatQuota(entry),
  ]));
  return EXIT.OK;
}

export async function main(argvInput, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const consoleErr = { error: (msg) => stderr.write(`${msg}\n`) };
  const handlerDeps = { ...deps, stdout, stderr, env: deps.env || process.env, cwd: deps.cwd || process.cwd() };
  let exitCode = EXIT.OK;
  const run = (handler) => async (argv) => {
    exitCode = await handler(argv, { ...handlerDeps, configFile: argv.configFile });
  };

  try {
    await yargs(argvInput)
      .scriptName("conductor daemon")
      .strict()
      .help()
      .option("json", { type: "boolean", default: false })
      .option("config-file", { type: "string", describe: "Path to Conductor config file" })
      .command(
        "list",
        "List online daemons with their CLI version and AI backends",
        (cmd) => cmd.option("all", {
          type: "boolean",
          default: false,
          describe: `Include ephemeral ${FIRE_HOST_PREFIX}* hosts`,
        }),
        run(handleList),
      )
      .command(
        "tools <host>",
        "Show which AI tools are installed on a daemon and whether they are reachable",
        (cmd) => cmd.positional("host", { type: "string", describe: "Daemon host name" }),
        run(handleTools),
      )
      .command(
        "quota <host>",
        "Show usage windows / balance for each AI tool on a daemon",
        (cmd) => cmd
          .positional("host", { type: "string", describe: "Daemon host name" })
          .option("tool", { type: "string", describe: "Only this tool, e.g. claude or codex" })
          .option("refresh", { type: "boolean", default: false, describe: "Bypass the daemon's quota cache" }),
        run(handleQuota),
      )
      .demandCommand(1)
      .fail((msg, err) => {
        // Throw so the command handler does not run after a validation error
        // (e.g. a missing <host>); yargs keeps going if fail() returns.
        if (err) throw err;
        throw Object.assign(new Error(msg), { code: "ARGS" });
      })
      .parseAsync();
  } catch (err) {
    exitCode = reportError(consoleErr, err);
  }
  return exitCode;
}
