import { runtimeProcessEnv } from "./process-env.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ChatRuntimeClient } from "./client.js";
import { runtimeDirectory, runtimeSocket } from "./server.js";
import { RuntimeError } from "./types.js";

export interface ManagedRuntimeOptions {
  directory?: string;
  executablePath?: string;
  channel?: string;
}
const starting = new Map<string, Promise<string>>();

/** Start one detached daemon shared by Conductor fire processes. Never submit/retry a turn. */
export async function ensureChatRuntime(options: ManagedRuntimeOptions = {}): Promise<string> {
  const directory = options.directory ?? runtimeDirectory();
  const socketPath = runtimeSocket(directory);
  const client = new ChatRuntimeClient(socketPath, 1000);
  const check = async () => {
    const status = await client.call<{ capabilities?: { accountBootstrap?: boolean; queuedStartup?: boolean; durableResume?: boolean } }>("runtime.status");
    if (status.capabilities?.accountBootstrap !== true || status.capabilities?.queuedStartup !== true || status.capabilities?.durableResume !== true) throw new RuntimeError("RUNTIME_UPGRADE_REQUIRED",
      "Chat runtime needs an upgrade. Stop it with conductor chat-web runtime stop, then retry; running chats are not stopped automatically");
    return socketPath;
  };
  try { return await check(); } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const existing = starting.get(socketPath);
  if (existing) return existing;
  const opening = (async () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const target = new URL("./daemon.js", import.meta.url);
    const compiled = fs.existsSync(target);
    const worker = fileURLToPath(compiled ? target : new URL("./daemon.ts", import.meta.url));
    const args = compiled ? [] : ["--import", createRequire(import.meta.url).resolve("tsx")];
    const log = path.join(directory, "daemon.log");
    const fd = fs.openSync(log, "a", 0o600);
    let launchError: Error | undefined;
    try {
      const child = spawn(process.execPath, [...args, worker, JSON.stringify({ directory, socketPath, executablePath: options.executablePath, channel: options.channel })], {
        detached: true, stdio: ["ignore", fd, fd], env: runtimeProcessEnv(),
      });
      child.on("error", error => { launchError = error; });
      child.unref();
    } finally { fs.closeSync(fd); }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      try { return await check(); } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new RuntimeError("RUNTIME_START_FAILED", "Chat runtime did not start; inspect " + log);
  })();
  starting.set(socketPath, opening);
  try { return await opening; } finally { starting.delete(socketPath); }
}
