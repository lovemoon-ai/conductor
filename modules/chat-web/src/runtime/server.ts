import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { rootDir } from "../core/paths.js";
import { ChatRuntime, type RuntimeOptions } from "./engine.js";
import { isTerminal, RuntimeError, type TurnEvent, type TurnStatus } from "./types.js";

export function runtimeDirectory(): string { return path.join(rootDir(), "runtime"); }
export function runtimeSocket(directory = runtimeDirectory()): string {
  return process.env.CHAT_WEB_RUNTIME_SOCKET ?? (process.platform === "win32"
    ? "\\\\.\\pipe\\chat-web-" + createHash("sha256").update(directory).digest("hex").slice(0, 16)
    : path.join(directory, "runtime.sock"));
}

async function acquireLock(directory: string): Promise<() => Promise<void>> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "runtime.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
      return async () => {
        const owner = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"));
        if (owner.token === token) await fs.unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"));
      if (!Number.isInteger(owner.pid)) throw new RuntimeError("RUNTIME_LOCKED", "Runtime lock is incomplete; inspect it before restarting");
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { await fs.unlink(file); continue; }
        throw error;
      }
      throw new RuntimeError("RUNTIME_LOCKED", "Another runtime owns this state directory");
    }
  }
  throw new RuntimeError("RUNTIME_LOCKED", "Unable to acquire runtime ownership");
}

export async function startRuntimeServer(options: RuntimeOptions & { socketPath?: string }) {
  const socketPath = options.socketPath ?? runtimeSocket(options.directory);
  const unlock = await acquireLock(options.directory);
  let runtime: ChatRuntime | undefined;
  let stop: Promise<void> | undefined;
  let lastActivity = Date.now();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: error.code ?? "INVALID_REQUEST", message: String(error.message ?? error).slice(0, 1000) } }));
    });
  });

  const close = (): Promise<void> => stop ??= (async () => {
    try { await runtime?.shutdown(); }
    finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (process.platform !== "win32") await fs.unlink(socketPath).catch(() => undefined);
      } finally { await unlock(); resolveClosed(); }
    }
  })();

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    lastActivity = Date.now();
    const api = runtime!;
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/events") {
      const id = url.searchParams.get("turnId") ?? "";
      const after = Number(url.searchParams.get("after") ?? 0);
      const history = api.history(id, after);
      const turn = api.getTurn(id);
      if (after > (turn.events.at(-1)?.seq ?? 0)) throw new RuntimeError("INVALID_PARAMS", "Sequence is ahead of this turn");
      response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      let last = after;
      let queuedBytes = 0;
      let output = Promise.resolve();
      let unsubscribe = () => {};
      const write = (event: TurnEvent) => {
        if (event.seq <= last || response.destroyed || response.writableEnded) return;
        last = event.seq;
        const line = JSON.stringify(event) + "\n";
        queuedBytes += Buffer.byteLength(line);
        if (queuedBytes > 4_000_000) { response.destroy(); return; }
        output = output.then(async () => {
          if (response.destroyed || response.writableEnded) return;
          if (!response.write(line)) await new Promise<void>((resolve) => {
            const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
            response.once("drain", done);
            response.once("close", done);
          });
          if (isTerminal(event.type as TurnStatus)) { unsubscribe(); response.end(); }
        }).finally(() => { queuedBytes -= Buffer.byteLength(line); });
        void output.catch(() => response.destroy());
      };
      unsubscribe = api.subscribe(id, write);
      response.on("close", () => unsubscribe());
      for (const event of history) write(event);
      if (isTerminal(turn.status)) { unsubscribe(); void output.then(() => response.end()); }
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/rpc") {
      response.writeHead(404); response.end(); return;
    }
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > 1_000_000) throw new RuntimeError("INVALID_REQUEST", "Request body exceeds limit");
    }
    const input = JSON.parse(body);
    if (input.jsonrpc !== "2.0" || typeof input.method !== "string" || (input.params !== undefined &&
      (!input.params || typeof input.params !== "object" || Array.isArray(input.params)))) throw new RuntimeError("INVALID_REQUEST", "Invalid JSON RPC request");
    const params = input.params ?? {};
    let result: unknown;
    try {
      switch (input.method) {
        case "runtime.status": result = api.status(); break;
        case "runtime.stop": result = { stopping: true }; break;
        case "conversations.create": result = await api.create(params); break;
        case "conversations.list": result = api.list(); break;
        case "conversations.get": result = api.get(params.id); break;
        case "conversations.resume": result = await api.resume(params.id, params); break;
        case "conversations.close": result = await api.closeConversation(params.id); break;
        case "turns.create": result = await api.submit(params); break;
        case "turns.get": result = api.getTurn(params.id); break;
        case "turns.cancel": result = await api.cancel(params.id); break;
        default: throw new RuntimeError("METHOD_NOT_FOUND", "Unknown runtime method");
      }
      if (result && typeof result === "object" && "events" in result) result = { ...result, events: undefined };
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
      if (input.method === "runtime.stop") setImmediate(() => { void close().catch(() => server.closeAllConnections()); });
    } catch (error: any) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id,
        error: { code: error.code === "METHOD_NOT_FOUND" ? -32601 : error.code === "INVALID_PARAMS" ? -32602 : -32000,
          message: String(error.message ?? error).slice(0, 1000), data: { reason: error.code ?? "RUNTIME_ERROR" } } }));
    }
  }

  try {
    if (process.platform !== "win32") {
      await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      const existing = await fs.lstat(socketPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (existing) {
        if (!existing.isSocket()) throw new RuntimeError("SOCKET_EXISTS", "Socket path is occupied by a regular file");
        const active = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection(socketPath);
          socket.once("connect", () => { socket.destroy(); resolve(true); });
          socket.once("error", () => resolve(false));
          socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
        });
        if (active) throw new RuntimeError("RUNTIME_LOCKED", "Socket already has a listener");
        await fs.unlink(socketPath);
      }
    }
    runtime = await ChatRuntime.open(options);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    if (process.platform !== "win32") await fs.chmod(socketPath, 0o600);
    return { runtime, socketPath, close, closed, get lastActivity() { return lastActivity; } };
  } catch (error) {
    await runtime?.shutdown();
    await unlock();
    throw error;
  }
}
