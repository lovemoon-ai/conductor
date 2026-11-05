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
  it.each([{ deepThink: true }, { deepThink: true, accountBootstrap: true }, { deepThink: true, accountBootstrap: true, queuedStartup: true }])("rejects an older daemon without spawning or stopping it (%j)", async capabilities => {
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

  it("does not leak fire identity into the detached daemon or browser worker, while preserving browser/proxy configuration", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-env-"));
    const keys = ["CONDUCTOR_AGENT_TOKEN", "CONDUCTOR_TASK_ID", "conductor_test_scope", "CHAT_WEB_HOME", "CHAT_WEB_BROWSER_CHANNEL", "HTTP_PROXY", "NODE_OPTIONS"];
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    const probe = path.join(directory, "probe.mjs");
    const daemonEvidence = path.join(directory, "daemon-env.json"), workerEvidence = path.join(directory, "worker-env.json");
    await fs.writeFile(probe, [
      "import fs from 'node:fs';",
      "const entry = process.argv[1] ?? '';",
      "const file = /[\\\\/]runtime[\\\\/]daemon\\.(ts|js)$/.test(entry) ? " + JSON.stringify(daemonEvidence) + " : /[\\\\/]runtime[\\\\/]worker\\.(ts|js)$/.test(entry) ? " + JSON.stringify(workerEvidence) + " : null;",
      "if (file) fs.writeFileSync(file, JSON.stringify({ identityKeys: Object.keys(process.env).filter(k => /^CONDUCTOR_/i.test(k)), home: process.env.CHAT_WEB_HOME, channel: process.env.CHAT_WEB_BROWSER_CHANNEL, proxy: process.env.HTTP_PROXY }), {mode:0o600});",
    ].join("\n"));
    const client = new ChatRuntimeClient(runtimeSocket(directory));
    let worker: import("../src/runtime/browser-worker.js").BrowserWorker | undefined;
    try {
      process.env.CONDUCTOR_AGENT_TOKEN = "fake-test-token";
      process.env.CONDUCTOR_TASK_ID = "fake-test-task";
      process.env.conductor_test_scope = "fake-test-scope";
      process.env.CHAT_WEB_HOME = path.join(directory, "home");
      process.env.CHAT_WEB_BROWSER_CHANNEL = "test-browser-config";
      process.env.HTTP_PROXY = "http://127.0.0.1:1";
      process.env.NODE_OPTIONS = [previous.get("NODE_OPTIONS"), "--import=" + probe].filter(Boolean).join(" ");
      await ensureChatRuntime({ directory });
      const { BrowserWorker } = await import("../src/runtime/browser-worker.js");
      // Construct and close an IPC worker without opening a browser or site.
      worker = new BrowserWorker({
        conversation: { id: "env-probe", provider: "kimi", accountId: "default", headless: true, createdAt: new Date().toISOString(), closed: false, needsReview: false },
        profileDir: path.join(directory, "profiles", "env-probe"),
        site: { name: "kimi", homeUrl: "http://127.0.0.1:1/", input: "textarea", send: "button", assistant: "article", stop: ".stop", conversationPath: "/chat/(.+)", streamPath: "/stream", format: "kimi" },
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !await fs.stat(workerEvidence).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 20));
      for (const file of [daemonEvidence, workerEvidence]) {
        const env = JSON.parse(await fs.readFile(file, "utf8"));
        expect(env).toEqual({ identityKeys: [], home: path.join(directory, "home"), channel: "test-browser-config", proxy: "http://127.0.0.1:1" });
      }
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await worker?.close();
      await client.call("runtime.stop").catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

});
