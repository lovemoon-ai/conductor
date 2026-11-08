import http from "node:http";
import { randomUUID } from "node:crypto";
import { runtimeDirectory, runtimeSocket } from "./server.js";
import type { ManagedRuntimeOptions } from "./managed.js";
import { isTerminal, RuntimeError, type Conversation, type Turn, type TurnEvent, type TurnStatus, type WorkerResult } from "./types.js";

export class ChatRuntimeClient {
  constructor(readonly socketPath = runtimeSocket(), private readonly requestTimeoutMs = 65_000) {}

  call<T = unknown>(method: string, params: object = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, path: "/rpc", method: "POST", agent: false,
        headers: { "content-type": "application/json" } }, (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 8_000_000) { response.destroy(new Error("Runtime response exceeds limit")); }
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const envelope = JSON.parse(body);
            if (envelope.error) reject(new RuntimeError(envelope.error.data?.reason ?? String(envelope.error.code), envelope.error.message));
            else resolve(envelope.result as T);
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(new RuntimeError("RUNTIME_TIMEOUT", "Runtime request timed out")));
      request.on("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }));
    });
  }

  private async checkDeepThink(value: unknown): Promise<void> {
    if (value === undefined) return;
    if (typeof value !== "boolean") throw new RuntimeError("INVALID_PARAMS", "deepThink must be boolean");
    const status = await this.call<{ capabilities?: { deepThink?: boolean } }>("runtime.status");
    if (status.capabilities?.deepThink !== true) throw new RuntimeError("UNSUPPORTED_OPTION", "Runtime does not support DeepThink; restart it with the updated chat-web package");
  }

  async create(params: { provider: string; accountId?: string; headless?: boolean; deepThink?: boolean; providerConversationId?: string }): Promise<Conversation> {
    await this.checkDeepThink(params.deepThink);
    return this.call("conversations.create", params);
  }
  list(): Promise<Conversation[]> { return this.call("conversations.list"); }
  get(id: string): Promise<Conversation> { return this.call("conversations.get", { id }); }
  resume(id: string, options: { headed?: boolean; acknowledgeUncertain?: boolean; allowQueued?: boolean } = {}): Promise<Conversation & WorkerResult> { return this.call("conversations.resume", { id, ...options }); }
  closeConversation(id: string): Promise<Conversation> { return this.call("conversations.close", { id }); }
  async submit(params: { conversationId: string; input: string; requestId: string; timeoutMs?: number; deepThink?: boolean }): Promise<Turn> {
    await this.checkDeepThink(params.deepThink);
    return this.call("turns.create", params);
  }
  getTurn(id: string): Promise<Turn> { return this.call("turns.get", { id }); }
  cancel(id: string): Promise<Turn> { return this.call("turns.cancel", { id }); }

  async *events(turnId: string, after = 0, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    const request = http.request({ socketPath: this.socketPath,
      path: "/events?turnId=" + encodeURIComponent(turnId) + "&after=" + after,
      method: "GET", agent: false, signal });
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
      request.end();
    });
    response.setEncoding("utf8");
    try {
      if (response.statusCode !== 200) {
        let body = "";
        for await (const chunk of response) body += chunk;
        const envelope = JSON.parse(body);
        throw new RuntimeError(envelope.error?.code ?? "RUNTIME_ERROR", envelope.error?.message ?? "Event subscription failed");
      }
      let pending = "";
      for await (const chunk of response) {
        pending += chunk;
        if (pending.length > 2_000_000) throw new RuntimeError("RESPONSE_LIMIT", "Event frame exceeds limit");
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line) yield JSON.parse(line) as TurnEvent;
        }
      }
      if (pending.trim()) throw new RuntimeError("DISCONNECTED", "Truncated runtime event");
    } finally { response.destroy(); request.destroy(); }
  }

  async wait(turnId: string, onEvent?: (event: TurnEvent) => void, signal?: AbortSignal): Promise<Turn> {
    let after = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        for await (const event of this.events(turnId, after, signal)) {
          if (event.seq <= after) continue;
          after = event.seq;
          onEvent?.(event);
          if (isTerminal(event.type as Turn["status"])) return this.getTurn(turnId);
        }
        const turn = await this.getTurn(turnId);
        if (isTerminal(turn.status)) return turn;
      } catch (error) {
        if (signal?.aborted) throw new RuntimeError("CLIENT_CLOSED", "Client event subscription closed; remote turn continues");
        if (error instanceof RuntimeError && !["DISCONNECTED", "RUNTIME_ERROR"].includes(error.code)) throw error;
        const current = await this.getTurn(turnId).catch(() => undefined);
        if (current && isTerminal(current.status)) return current;
        if (attempt === 3) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
    throw new RuntimeError("DISCONNECTED", "Event stream ended before this turn completed");
  }
}

export class RuntimeChatSession {
  readonly client: ChatRuntimeClient;
  readonly provider: string;
  private activeTurnId?: string;
  private interruptRequested = false;
  private sending = false;
  private localWait?: AbortController;
  private turns = 0;
  private closed = false;
  private constructor(readonly id: string, provider: string, socket: string | undefined, private deepThink?: boolean, private releaseOnClose = false, public providerConversationId?: string, private managedOptions?: ManagedRuntimeOptions) {
    this.provider = provider;
    this.client = new ChatRuntimeClient(socket);
  }
  static async open(provider: string, options: { socketPath?: string; conversationId?: string; providerConversationId?: string; accountId?: string; headless?: boolean; deepThink?: boolean; releaseOnClose?: boolean; launch?: { executablePath?: string; channel?: string } } = {}): Promise<RuntimeChatSession> {
    if (options.deepThink !== undefined && (provider !== "deepseek" || typeof options.deepThink !== "boolean")) {
      throw new RuntimeError("INVALID_PARAMS", "DeepThink requires a boolean and the DeepSeek provider");
    }
    const managedOptions = options.socketPath ? undefined : { ...options.launch, directory: runtimeDirectory() };
    const socket = options.socketPath ?? await (await import("./managed.js")).ensureChatRuntime(managedOptions);
    const client = new ChatRuntimeClient(socket);
    const chat = options.conversationId ? await client.get(options.conversationId) : await client.create({ provider, accountId: options.accountId, headless: options.headless, deepThink: options.deepThink, providerConversationId: options.providerConversationId });
    if (chat.provider !== provider) throw new RuntimeError("PROVIDER_MISMATCH", "Saved conversation uses a different provider");
    return new RuntimeChatSession(chat.id, provider, socket, options.deepThink, options.releaseOnClose, chat.providerConversationId, managedOptions);
  }
  private async ensureAvailable(): Promise<void> {
    if (this.closed) throw new RuntimeError("CHAT_CLOSED", "SDK session is closed");
    if (this.managedOptions) await (await import("./managed.js")).ensureChatRuntime(this.managedOptions);
    if (this.closed) throw new RuntimeError("CHAT_CLOSED", "SDK session is closed");
  }
  /** Defer browser/auth verification until the queued send owns a worker slot. */
  async prepare(): Promise<WorkerResult> { await this.ensureAvailable(); return this.client.resume(this.id, { allowQueued: true }); }
  async isLoggedIn(): Promise<boolean> { await this.ensureAvailable(); return !!(await this.client.resume(this.id)).ready; }
  async send(message: string, options: { requestId?: string; timeoutMs?: number; onProgress?: (text: string) => void; onStatus?: (status: TurnStatus) => void; signal?: AbortSignal; deepThink?: boolean } = {}) {
    if (options.deepThink !== undefined && typeof options.deepThink !== "boolean") throw new RuntimeError("INVALID_PARAMS", "deepThink must be boolean");
    if (this.closed) throw new RuntimeError("CHAT_CLOSED", "SDK session is closed");
    if (this.sending) throw new RuntimeError("CHAT_BUSY", "This SDK session already has an active send");
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.sending = true;
    this.interruptRequested = false;
    this.localWait = new AbortController();
    const start = Date.now();
    const abort = () => { void this.interruptCurrentTurn().catch(() => undefined); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.ensureAvailable();
      if (options.signal?.aborted || this.interruptRequested) throw new DOMException("Aborted", "AbortError");
      const turn = await this.client.submit({ conversationId: this.id, input: message, requestId: options.requestId ?? randomUUID(), timeoutMs: options.timeoutMs, deepThink: options.deepThink ?? this.deepThink });
      this.activeTurnId = turn.id;
      if (this.interruptRequested) await this.client.cancel(turn.id);
      let text = "";
      const result = await this.client.wait(turn.id, (event) => {
        if (this.closed) return;
        if (event.type === "message_delta") text += event.text ?? "";
        else if (event.type === "message_snapshot") text = event.text ?? "";
        else { options.onStatus?.(event.type as TurnStatus); return; }
        options.onProgress?.(text);
      }, this.localWait.signal);
      if (this.closed) throw new RuntimeError("CLIENT_CLOSED", "Client detached; remote turn continues");
      if (result.status !== "completed") throw Object.assign(
        new RuntimeError(result.errorCode ?? result.status.toUpperCase(), result.error ?? result.status),
        { turnStatus: result.status, turnId: result.id, ...(result.status === "cancelled" ? { reason: "turn_cancelled" } : {}) },
      );
      const chat = await this.client.get(this.id);
      return { response: result.text, message, turnIndex: this.turns++, durationMs: Date.now() - start,
        conversationId: chat.providerConversationId, runtimeConversationId: this.id };
    } finally { options.signal?.removeEventListener("abort", abort); this.activeTurnId = undefined; this.localWait = undefined; this.sending = false; }
  }

  async interruptCurrentTurn(): Promise<void> { this.interruptRequested = true; if (this.activeTurnId) await this.client.cancel(this.activeTurnId); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.localWait?.abort();
    // Conductor owns these conversations; closing a task releases its browser.
    // Explicit socket clients keep the original detach-only behavior.
    if (this.releaseOnClose) {
      try { await this.client.closeConversation(this.id); } catch (error) {
        // An idle managed daemon already released its browsers. Never restart just to close.
        if (!this.managedOptions || !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }
}
