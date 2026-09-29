#!/usr/bin/env node

/**
 * conductor auth — who am I, and the API tokens shown on the web settings page.
 *
 * Subcommands:
 *   whoami                     GET  /api/auth/me                       -> { user: { id, email, phone, tokenScope } }
 *   tokens list                GET  /api/auth/tokens                   -> [{ id, name, token_prefix, created_at, last_used_at }]
 *   tokens create [--name N]   POST /api/auth/tokens { name }          -> { token, tokenId, tokenPrefix, createdAt }
 *   tokens revoke <tokenId>    POST /api/auth/tokens/:tokenId/revoke   -> 204
 *
 * `tokens create` prints the raw token once (the server never lists it again).
 * Login / register / OAuth are intentionally not here: `conductor config`
 * handles signing in.
 *
 * Global flags: --json, --dry-run (write verbs), --config-file.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { EXIT, exitCodeForError, printJson, printPretty, reportError } from "../src/entity-helpers.js";
import { apiPath, buildHttp, formatTable, sendOrPreview } from "../src/backend-http.js";

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

const DEFAULT_TOKEN_NAME = "cli";

async function handleWhoami(argv, deps) {
  const http = await buildHttp(deps);
  const result = await http.get(apiPath("auth", "me"));
  if (argv.json) {
    printJson(deps.stdout, result);
    return EXIT.OK;
  }
  const user = result?.user ?? {};
  printPretty(deps.stdout, `id:      ${user.id ?? ""}`);
  if (user.email) printPretty(deps.stdout, `email:   ${user.email}`);
  if (user.phone) printPretty(deps.stdout, `phone:   ${user.phone}`);
  if (user.tokenScope) printPretty(deps.stdout, `scope:   ${user.tokenScope}`);
  printPretty(deps.stdout, `backend: ${http.baseUrl}`);
  return EXIT.OK;
}

async function handleTokensList(argv, deps) {
  const http = await buildHttp(deps);
  const result = await http.get(apiPath("auth", "tokens"));
  if (argv.json) {
    printJson(deps.stdout, result);
    return EXIT.OK;
  }
  const tokens = Array.isArray(result) ? result : [];
  if (tokens.length === 0) {
    printPretty(deps.stdout, "(no tokens)");
    return EXIT.OK;
  }
  const rows = tokens.map((token) => [
    token.id, token.token_prefix ?? "", token.created_at ?? "", token.last_used_at ?? "-", token.name ?? "",
  ]);
  for (const line of formatTable(["ID", "PREFIX", "CREATED", "LAST USED", "NAME"], rows)) {
    printPretty(deps.stdout, line);
  }
  return EXIT.OK;
}

async function handleTokensCreate(argv, deps) {
  const http = await buildHttp(deps);
  const body = { name: String(argv.name ?? DEFAULT_TOKEN_NAME) };
  const { dryRun, data } = await sendOrPreview(http, argv, deps, "POST", apiPath("auth", "tokens"), body);
  if (dryRun) return EXIT.OK;
  deps.stderr.write("Warning: this token is shown only once. Store it somewhere safe now.\n");
  if (argv.json) {
    printJson(deps.stdout, data);
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Created token ${data?.tokenId ?? ""} (${body.name}, prefix ${data?.tokenPrefix ?? ""})`);
  printPretty(deps.stdout, `token: ${data?.token ?? ""}`);
  return EXIT.OK;
}

async function handleTokensRevoke(argv, deps) {
  const http = await buildHttp(deps);
  const tokenId = String(argv.tokenId);
  const { dryRun } = await sendOrPreview(
    http, argv, deps, "POST", apiPath("auth", "tokens", tokenId, "revoke"), undefined,
  );
  if (dryRun) return EXIT.OK;
  if (argv.json) {
    printJson(deps.stdout, { revoked: true, tokenId });
    return EXIT.OK;
  }
  printPretty(deps.stdout, `Revoked token ${tokenId}`);
  return EXIT.OK;
}

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

  let exitCode = EXIT.OK;
  try {
    await yargs(argvInput)
      .scriptName("conductor auth")
      .strict()
      .help()
      .option("json", { type: "boolean", default: false })
      .option("dry-run", { type: "boolean", default: false })
      .option("config-file", { type: "string", describe: "Path to Conductor config file" })
      .command("whoami", "Show the user the configured token belongs to", () => {}, run(handleWhoami))
      .command("tokens", "List, create, or revoke API tokens", (tokens) => tokens
        .command("list", "List active API tokens", () => {}, run(handleTokensList))
        .command(
          "create",
          "Create an API token (the token is printed once)",
          (cmd) => cmd.option("name", { type: "string", describe: `Token label (default "${DEFAULT_TOKEN_NAME}")` }),
          run(handleTokensCreate),
        )
        .command(
          "revoke <tokenId>",
          "Revoke an API token",
          (cmd) => cmd.positional("tokenId", { type: "string", demandOption: true }),
          run(handleTokensRevoke),
        )
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
