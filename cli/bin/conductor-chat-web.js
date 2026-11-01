#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { resolveConductorConfigPath } from "../src/conductor-paths.js";

export async function runChatWebCommand(args = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? (text => process.stdout.write(text));
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    log("Usage: conductor chat-web login <kimi|deepseek> [--config-file PATH]\n       conductor chat-web <serve|chat|turn|runtime> ...\n\nSign in once on the daemon host. web-kimi and web-deepseek start their runtime automatically.\n");
    return 0;
  }
  const env = deps.env ?? process.env;
  const forwarded = [];
  let configFile;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") { forwarded.push(...args.slice(i)); break; }
    if (args[i] === "--config-file") {
      if (!args[i + 1]) throw new Error("--config-file requires a path");
      configFile = args[++i];
    } else if (args[i].startsWith("--config-file=")) {
      configFile = args[i].slice("--config-file=".length);
      if (!configFile) throw new Error("--config-file requires a path");
    } else forwarded.push(args[i]);
  }
  args = forwarded;
  const configPath = resolveConductorConfigPath(configFile, env);
  if (configFile && !fs.existsSync(configPath)) throw new Error("Conductor config not found: " + configPath);
  if (fs.existsSync(configPath)) {
    const config = yaml.load(fs.readFileSync(configPath, "utf8"));
    for (const [key, value] of Object.entries(config?.envs ?? {})) {
      if (/^(CHAT_WEB_|https?_proxy$|all_proxy$|no_proxy$)/i.test(key) && env[key] === undefined && value !== null && value !== undefined) env[key] = String(value);
    }
  }
  const req = createRequire(import.meta.url);
  let mod;
  try { mod = deps.chatWebModule ?? await import("@love-moon/chat-web"); }
  catch { throw new Error("Browser chat is unavailable. Install @love-moon/chat-web on this daemon host."); }
  if (args[0] === "login") {
    if (args.length !== 2 || !["kimi", "deepseek"].includes(args[1])) throw new Error("Usage: conductor chat-web login <kimi|deepseek>");
    if (typeof mod.RuntimeChatSession?.open !== "function") throw new Error("Upgrade @love-moon/chat-web to use Conductor browser chat login");
    mod.registerBuiltinProviders();
    await mod.login(args[1], { autoExit: true });
    log("Browser chat account saved. Select web-" + args[1] + " in Conductor.\n");
    return 0;
  }
  const entry = deps.cliEntry ?? path.join(path.dirname(req.resolve("@love-moon/chat-web/package.json")), "dist/cli.js");
  // The packaged CLI handles socket management and prints structured results.
  process.argv = [process.execPath, entry, ...args];
  await (deps.importCli ?? (url => import(url)))(pathToFileURL(entry).href);
}

const entry = process.argv[1];
if (entry && fs.existsSync(entry) && fs.realpathSync(entry) === fs.realpathSync(new URL(import.meta.url))) {
  runChatWebCommand().then(code => { if (typeof code === "number") process.exitCode = code; }, error => {
    process.stderr.write(error.message + "\n"); process.exitCode = 1;
  });
}
