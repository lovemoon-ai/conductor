import http from "node:http";
import { randomUUID } from "node:crypto";
import { runtimeSocket } from "./server.js";
import { isTerminal, RuntimeError, type Conversation, type Turn, type TurnEvent, type WorkerResult } from "./types.js";

export class ChatRuntimeClient {
  constructor(readonly socketPath = runtimeSocket()) {}

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
      request.setTimeout(65_000, () => request.destroy(new RuntimeError("RUNTIME_TIMEOUT", "Runtime request timed out")));
      request.on("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }));
    });
  }

  create(params: { provider: string; accountId?: string; headless?: boolean }): Promise<Conversation> { return this.call("conversations.create", params); }
  list(): Promise<Conversation[]> { return this.call("conversations.list"); }
  get(id: string): Promise<Conversation> { return this.call("conversations.get", { id }); }
  resume(id: string, options: { headed?: boolean; acknowledgeUncertain?: boolean } = {}): Promise<Conversation & WorkerResult> { return this.call("conversations.resume", { id, ...options }); }
  closeConversation(id: string): Promise<Conversation> { return this.call("conversations.close", { id }); }
  submit(params: { conversationId: string; input: string; requestId: string; timeoutMs?: number }): Promise<Turn> { return this.call("turns.create", params); }
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
  private constructor(readonly id: string, provider: string, socket: string | undefined) {
    this.provider = provider;
    this.client = new ChatRuntimeClient(socket);
  }
  static async open(provider: string, options: { socketPath?: string; conversationId?: string; accountId?: string; headless?: boolean } = {}): Promise<RuntimeChatSession> {
    const client = new ChatRuntimeClient(options.socketPath);
    const chat = options.conversationId ? await client.get(options.conversationId) : await client.create({ provider, accountId: options.accountId, headless: options.headless });
    if (chat.provider !== provider) throw new RuntimeError("PROVIDER_MISMATCH", "Saved conversation uses a different provider");
    return new RuntimeChatSession(chat.id, provider, options.socketPath);
  }
  async isLoggedIn(): Promise<boolean> { return !!(await this.client.resume(this.id)).ready; }
  async send(message: string, options: { requestId?: string; timeoutMs?: number; onProgress?: (text: string) => void } = {}) {
    if (this.closed) throw new RuntimeError("CHAT_CLOSED", "SDK session is closed");
    if (this.sending) throw new RuntimeError("CHAT_BUSY", "This SDK session already has an active send");
    this.sending = true;
    this.interruptRequested = false;
    this.localWait = new AbortController();
    const start = Date.now();
    try {
      const turn = await this.client.submit({ conversationId: this.id, input: message, requestId: options.requestId ?? randomUUID(), timeoutMs: options.timeoutMs });
      this.activeTurnId = turn.id;
      if (this.interruptRequested) await this.client.cancel(turn.id);
      let text = "";
      const result = await this.client.wait(turn.id, (event) => {
        if (this.closed) return;
        if (event.type === "message_delta") text += event.text ?? "";
        else if (event.type === "message_snapshot") text = event.text ?? "";
        else return;
        options.onProgress?.(text);
      }, this.localWait.signal);
      if (this.closed) throw new RuntimeError("CLIENT_CLOSED", "Client detached; remote turn continues");
      if (result.status !== "completed") throw new RuntimeError(result.status.toUpperCase(), result.error ?? result.status);
      const chat = await this.client.get(this.id);
      return { response: result.text, message, turnIndex: this.turns++, durationMs: Date.now() - start,
        conversationId: chat.providerConversationId, runtimeConversationId: this.id };
    } finally { this.activeTurnId = undefined; this.localWait = undefined; this.sending = false; }
  }

  async interruptCurrentTurn(): Promise<void> { this.interruptRequested = true; if (this.activeTurnId) await this.client.cancel(this.activeTurnId); }
  async close(): Promise<void> { this.closed = true; this.localWait?.abort(); }
}
