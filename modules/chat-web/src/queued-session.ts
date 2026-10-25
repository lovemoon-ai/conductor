import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { BROKER_PROTOCOL, brokerPaths, type WireError } from "./core/broker-protocol.js";
import { ChatWebError } from "./core/errors.js";
import { logsDir } from "./core/paths.js";
import type { ProviderDiagnostics } from "./core/provider.js";
import type { PageSnapshot } from "./core/snapshot.js";
import type { SendOptions, SendResult, SessionOpenOptions } from "./session.js";

type Pending = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onProgress?: (text: string) => void;
  onQueue?: (position: number) => void;
  cleanup(): void;
};

class BrokerConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private intentionalClose = false;

  constructor(private readonly socket: net.Socket, private readonly provider: string) {
    const lines = readline.createInterface({ input: socket });
    lines.on("error", () => socket.destroy());
    lines.on("line", (line) => {
      let message: { id: number; type?: string; text?: string; position?: number; result?: unknown; error?: WireError };
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === "progress" || message.type === "queue") {
        try {
          if (message.type === "progress") pending.onProgress?.(message.text ?? "");
          else pending.onQueue?.(message.position ?? 0);
        } catch { /* User observers cannot interrupt the transport. */ }
        return;
      }
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) {
        const error = Object.assign(new Error(message.error.message), message.error);
        pending.reject(error);
      } else pending.resolve(message.result);
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      lines.close();
      for (const pending of this.pending.values()) {
        pending.cleanup();
        pending.reject(this.intentionalClose
          ? new DOMException("Chat session closed", "AbortError")
          : new ChatWebError("BROKER_UNAVAILABLE", "The chat-web browser broker disconnected. Create a new session; the previous message was not retried.", { provider }));
      }
      this.pending.clear();
    });
  }

  request<T>(method: string, args: Record<string, unknown> = {}, options: Pick<SendOptions, "signal" | "onProgress" | "onQueue"> = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.socket.destroyed) return Promise.reject(new ChatWebError("BROKER_UNAVAILABLE", "The chat-web browser broker is disconnected.", { provider: this.provider }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!this.socket.destroyed) this.socket.write(`${JSON.stringify({ type: "cancel", id })}\n`);
      };
      this.pending.set(id, {
        resolve: (value) => resolve(value as T), reject,
        onProgress: options.onProgress, onQueue: options.onQueue,
        cleanup: () => options.signal?.removeEventListener("abort", abort),
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      this.socket.write(`${JSON.stringify({ id, method, args })}\n`);
    });
  }

  destroy(): void { this.intentionalClose = true; this.socket.destroy(); }
}

async function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("error", fail);
    socket.setTimeout(1_000, () => fail(new Error("Broker connection timed out")));
    socket.once("connect", () => {
      socket.removeListener("error", fail);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function launchBroker(provider: string, options: SessionOpenOptions): void {
  let worker = fileURLToPath(new URL("./core/broker-worker.js", import.meta.url));
  const nodeArgs: string[] = [];
  if (!fs.existsSync(worker)) {
    worker = worker.replace(/\.js$/, ".ts");
    nodeArgs.push("--import", createRequire(import.meta.url).resolve("tsx"));
  }
  const launch = Object.fromEntries(Object.entries(options.launch ?? {}).filter(([key]) => key !== "logger"));
  fs.mkdirSync(logsDir(), { recursive: true });
  const fd = fs.openSync(path.join(logsDir(), `${provider.replace(/[^a-zA-Z0-9_-]/g, "_")}-broker.log`), "a", 0o600);
  try {
    const child = spawn(process.execPath, [...nodeArgs, worker, provider, JSON.stringify({ headless: options.headless, launch })], {
      detached: true, stdio: ["ignore", fd, fd], env: process.env,
    });
    child.on("error", () => { /* The connection deadline reports startup failure. */ });
    child.unref();
  } finally { fs.closeSync(fd); }
}

/**
 * A conversation tab in a profile-wide broker. Different processes share the
 * browser and FIFO, while every session keeps its own page and chat context.
 * Use ChatSession instead when direct Playwright Page access is required.
 */
export class QueuedChatSession {
  static async open(provider: string, options: SessionOpenOptions = {}): Promise<QueuedChatSession> {
    const paths = brokerPaths(provider);
    const deadline = Date.now() + 20_000;
    let nextLaunch = 0;
    let socket: net.Socket | undefined;
    while (Date.now() < deadline) {
      try { socket = await connect(paths.socket); break; }
      catch {
        if (Date.now() >= nextLaunch) { launchBroker(provider, options); nextLaunch = Date.now() + 500; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!socket) throw new ChatWebError("BROKER_UNAVAILABLE", "Could not start the chat-web browser broker. Check the provider broker log in the chat-web logs directory.", { provider });
    const connection = new BrokerConnection(socket, provider);
    try {
      const result = await connection.request<{ userDataDir: string }>("open", { protocol: BROKER_PROTOCOL, autoOpen: options.autoOpen });
      return new QueuedChatSession(provider, result.userDataDir, connection);
    } catch (error) { connection.destroy(); throw error; }
  }

  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private turnCounter = 0;
  private providerConversationId: string | undefined;

  private constructor(
    public readonly provider: string,
    public readonly userDataDir: string,
    private readonly connection: BrokerConnection,
  ) {}

  get turns(): number { return this.turnCounter; }
  get conversationId(): string | undefined { return this.providerConversationId; }
  get isClosed(): boolean { return this.closed; }

  async isLoggedIn(): Promise<boolean> { this.assertOpen(); return this.connection.request("isLoggedIn"); }
  async diagnose(): Promise<ProviderDiagnostics> { this.assertOpen(); return this.connection.request("diagnose"); }
  async snapshot(): Promise<PageSnapshot> { this.assertOpen(); return this.connection.request("snapshot"); }

  async send(message: string, options: SendOptions = {}): Promise<SendResult> {
    this.assertOpen();
    return this.enqueue(async () => {
      const result = await this.connection.request<SendResult>("send", {
        message, timeoutMs: options.timeoutMs, stableMs: options.stableMs, newChat: options.newChat,
      }, options);
      this.turnCounter = result.turnIndex + 1;
      this.providerConversationId = result.conversationId;
      return result;
    });
  }

  async newChat(): Promise<void> {
    this.assertOpen();
    return this.enqueue(async () => {
      await this.connection.request("newChat");
      this.turnCounter = 0;
      this.providerConversationId = undefined;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.connection.request("close"),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 8_000); }),
      ]);
    } catch { /* A disconnected broker has already released this client. */ }
    finally { if (timer) clearTimeout(timer); this.connection.destroy(); }
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }

  private assertOpen(): void {
    if (this.closed) throw new Error(`QueuedChatSession for "${this.provider}" is already closed.`);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = () => { this.assertOpen(); return task(); };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
