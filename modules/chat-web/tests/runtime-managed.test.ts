import os from "node:os";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { ChatRuntimeClient, RuntimeChatSession } from "../src/runtime/client.js";
import { runtimeSocket } from "../src/runtime/server.js";
import { ensureChatRuntime } from "../src/runtime/managed.js";

const exec = promisify(execFile);
describe("managed runtime process", () => {
  it("concurrent fire processes attach to one daemon and do not allocate a browser", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-managed-"));
    const client = new ChatRuntimeClient(runtimeSocket(directory));
    const loader = createRequire(import.meta.url).resolve("tsx");
    try {
      const source = new URL("../src/runtime/managed.ts", import.meta.url).href;
      const script = "import(" + JSON.stringify(source) + ").then(async m=>console.log(await m.ensureChatRuntime(" + JSON.stringify({ directory }) + ")))";
      const results = await Promise.all(Array.from({ length: 3 }, () => exec(process.execPath, ["--import", loader, "-e", script])));
      expect(new Set(results.map(r => r.stdout.trim())).size).toBe(1);
      const lock = JSON.parse(await fs.readFile(path.join(directory, "runtime.lock"), "utf8"));
      expect(Number.isInteger(lock.pid)).toBe(true);
      expect(await ensureChatRuntime({ directory })).toBe(client.socketPath);
      expect(await client.call("runtime.status")).toMatchObject({ workers: 0, activeTurns: 0, maxWorkers: 4 });
    } finally { await client.call("runtime.stop").catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it.each([{ deepThink: true }, { deepThink: true, accountBootstrap: true }])("rejects an older daemon without spawning or stopping it (%j)", async capabilities => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-old-"));
    const socket = runtimeSocket(directory);
    const server = http.createServer((_request, response) => { response.end(JSON.stringify({ jsonrpc: "2.0", result: { capabilities } })); });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try {
      await expect(ensureChatRuntime({ directory })).rejects.toMatchObject({ code: "RUNTIME_UPGRADE_REQUIRED" });
      expect(await fs.stat(path.join(directory, "daemon.log")).then(() => true, () => false)).toBe(false);
      expect(await new ChatRuntimeClient(socket).call("runtime.status")).toMatchObject({ capabilities: { deepThink: true } });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("shuts down an unused automatically started daemon", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-idle-"));
    const previous = process.env.CHAT_WEB_RUNTIME_IDLE_MS;
    const client = new ChatRuntimeClient(runtimeSocket(directory));
    try {
      process.env.CHAT_WEB_RUNTIME_IDLE_MS = "1000";
      await ensureChatRuntime({ directory });
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && await fs.stat(path.join(directory, "runtime.lock")).then(() => true, () => false)) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(await fs.stat(path.join(directory, "runtime.lock")).then(() => true, () => false)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CHAT_WEB_RUNTIME_IDLE_MS; else process.env.CHAT_WEB_RUNTIME_IDLE_MS = previous;
      await client.call("runtime.stop").catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("restarts a stopped managed daemon before a new submit, retaining the conversation", async () => {
    const home = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-restart-"));
    const previous = process.env.CHAT_WEB_HOME;
    let session: RuntimeChatSession | undefined;
    try {
      process.env.CHAT_WEB_HOME = home;
      session = await RuntimeChatSession.open("kimi", { releaseOnClose: true });
      const directory = path.join(home, "runtime");
      const before = JSON.parse(await fs.readFile(path.join(directory, "runtime.lock"), "utf8"));
      await session.client.call("runtime.stop");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && await fs.stat(path.join(directory, "runtime.lock")).then(() => true, () => false)) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Invalid input proves the daemon restarted without sending anything to a provider.
      await expect(session.send("")).rejects.toMatchObject({ code: "INVALID_PARAMS" });
      const after = JSON.parse(await fs.readFile(path.join(directory, "runtime.lock"), "utf8"));
      expect(after.pid).not.toBe(before.pid);
      expect((await session.client.get(session.id)).id).toBe(session.id);
      expect(await session.client.call("runtime.status")).toMatchObject({ workers: 0, activeTurns: 0 });
      await session.client.call("runtime.stop");
      await new Promise(resolve => setTimeout(resolve, 200));
      await expect(session.close()).resolves.toBeUndefined();
    } finally {
      await session?.close().catch(() => {});
      await session?.client.call("runtime.stop").catch(() => {});
      if (previous === undefined) delete process.env.CHAT_WEB_HOME; else process.env.CHAT_WEB_HOME = previous;
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 20_000);

});
