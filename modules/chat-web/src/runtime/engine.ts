import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BrowserWorker } from "./browser-worker.js";
import { RuntimeStore } from "./store.js";
import { runtimeSites } from "./sites.js";
import { isTerminal, RuntimeError, type ChatWorker, type Conversation, type RuntimeState, type SiteDefinition, type Turn, type TurnEvent, type TurnStatus, type WorkerFactory, type WorkerNotice, type WorkerResult } from "./types.js";

export interface RuntimeOptions {
  directory: string;
  maxWorkers?: number;
  perAccountConcurrency?: number;
  workerFactory?: WorkerFactory;
  sites?: SiteDefinition[];
  executablePath?: string;
  channel?: string;
}
interface WorkerEntry { worker: ChatWorker; used: number; headless: boolean; pinned: boolean; }

export class ChatRuntime {
  private events = new EventEmitter();
  private workers = new Map<string, WorkerEntry>();
  private busy = new Set<string>();
  private closing = new Set<string>();
  private active = new Map<string, Promise<void>>();
  private allocation: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private failure?: string;
  private scheduled = false;
  readonly maxWorkers: number;
  readonly perAccountConcurrency: number;
  readonly sites: SiteDefinition[];

  private constructor(private store: RuntimeStore, private options: RuntimeOptions) {
    this.maxWorkers = options.maxWorkers ?? 4;
    this.perAccountConcurrency = options.perAccountConcurrency ?? 2;
    for (const value of [this.maxWorkers, this.perAccountConcurrency]) {
      if (!Number.isInteger(value) || value < 1 || value > 64) throw new RuntimeError("INVALID_PARAMS", "Concurrency must be an integer from 1 to 64");
    }
    this.sites = options.sites ?? runtimeSites;
    this.events.setMaxListeners(0);
  }

  static async open(options: RuntimeOptions): Promise<ChatRuntime> {
    const runtime = new ChatRuntime(await RuntimeStore.open(options.directory), options);
    await runtime.store.update((state) => {
      for (const turn of Object.values(state.turns)) {
        if (!isTerminal(turn.status) && turn.status !== "queued") {
          turn.status = "uncertain";
          turn.error = "Runtime restarted while the turn was active; inspect before sending again";
          state.conversations[turn.conversationId]!.needsReview = true;
          runtime.append(turn, "uncertain", { error: turn.error });
        }
      }
    });
    runtime.schedule();
    return runtime;
  }

  private conversation(state: RuntimeState, id: string): Conversation {
    const conversation = Object.hasOwn(state.conversations, id) ? state.conversations[id] : undefined;
    if (!conversation) throw new RuntimeError("NOT_FOUND", "Conversation not found");
    return conversation;
  }
  private turn(state: RuntimeState, id: string): Turn {
    const turn = Object.hasOwn(state.turns, id) ? state.turns[id] : undefined;
    if (!turn) throw new RuntimeError("NOT_FOUND", "Turn not found");
    return turn;
  }

  list(): Conversation[] { return Object.values(this.store.read().conversations); }
  get(id: string): Conversation { return this.conversation(this.store.read(), id); }
  getTurn(id: string): Turn { return this.turn(this.store.read(), id); }
  status() {
    return { version: 1, capabilities: { deepThink: true }, maxWorkers: this.maxWorkers, perAccountConcurrency: this.perAccountConcurrency,
      workers: this.workers.size, activeTurns: this.active.size, stopping: this.stopping, failure: this.failure,
      pinnedChats: [...this.workers].filter(([, entry]) => entry.pinned).map(([id]) => id),
      providers: this.sites.map(({ name, experimental }) => ({ name, experimental: !!experimental })) };
  }

  async create(params: { provider: string; accountId?: string; headless?: boolean; deepThink?: boolean }): Promise<Conversation> {
    if (this.stopping) throw new RuntimeError("SHUTTING_DOWN", "Runtime is shutting down");
    if (!this.sites.some((site) => site.name === params.provider)) throw new RuntimeError("UNSUPPORTED_PROVIDER", "Unsupported webpage provider");
    this.validateDeepThink(params.provider, params.deepThink);
    const accountId = params.accountId ?? "default";
    if (typeof accountId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(accountId)) throw new RuntimeError("INVALID_PARAMS", "Invalid accountId");
    if (params.headless !== undefined && typeof params.headless !== "boolean") throw new RuntimeError("INVALID_PARAMS", "headless must be boolean");
    return this.store.update((state) => {
      if (Object.keys(state.conversations).length >= 256) throw new RuntimeError("CAPACITY", "Conversation limit reached");
      const record: Conversation = { id: randomUUID(), provider: params.provider, accountId,
        headless: params.headless ?? true, ...(params.deepThink === undefined ? {} : { deepThink: params.deepThink }), createdAt: new Date().toISOString(), needsReview: false, closed: false };
      state.conversations[record.id] = record;
      return record;
    });
  }

  async resume(id: string, params: { headed?: boolean; acknowledgeUncertain?: boolean } = {}): Promise<Conversation & WorkerResult> {
    if (this.stopping) throw new RuntimeError("SHUTTING_DOWN", "Runtime is shutting down");
    if ([params.headed, params.acknowledgeUncertain].some((value) => value !== undefined && typeof value !== "boolean")) throw new RuntimeError("INVALID_PARAMS", "Resume options must be boolean");
    if (this.busy.has(id) || this.closing.has(id)) throw new RuntimeError("CHAT_BUSY", "Conversation has an active operation");
    this.get(id);
    if (this.busy.size >= this.maxWorkers) throw new RuntimeError("CAPACITY", "All browser workers are busy");
    this.busy.add(id);
    try {
      const conversation = await this.store.update((state) => {
        const chat = this.conversation(state, id);
        if (params.headed !== undefined) chat.headless = !params.headed;
        if (params.acknowledgeUncertain) chat.needsReview = false;
        chat.closed = false;
        return chat;
      });
      const worker = await this.acquire(conversation);
      const result = await worker.open();
      if (params.headed === true) this.workers.get(id)!.pinned = true;
      await this.remember(id, result);
      return { ...this.get(id), ...result };
    } finally { this.busy.delete(id); this.schedule(); }
  }

  async closeConversation(id: string): Promise<Conversation> {
    this.get(id);
    if (this.closing.has(id)) throw new RuntimeError("CHAT_BUSY", "Conversation is closing");
    this.closing.add(id);
    try {
      await this.store.update((state) => {
        this.conversation(state, id).closed = true;
      });
      for (const turn of Object.values(this.store.read().turns)) {
        if (turn.conversationId === id && !isTerminal(turn.status)) await this.cancel(turn.id);
      }
      await this.drop(id);
      return this.get(id);
    } finally { this.closing.delete(id); this.schedule(); }
  }

  async submit(params: { conversationId: string; requestId: string; input: string; timeoutMs?: number; deepThink?: boolean }): Promise<Turn> {
    if (this.stopping) throw new RuntimeError("SHUTTING_DOWN", "Runtime is shutting down");
    if (typeof params.input !== "string" || !params.input.trim() || params.input.length > 100_000 ||
        typeof params.requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(params.requestId)) {
      throw new RuntimeError("INVALID_PARAMS", "A nonempty input and stable requestId are required");
    }
    const timeoutMs = params.timeoutMs ?? 180_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1_800_000) throw new RuntimeError("INVALID_PARAMS", "Invalid timeoutMs");
    const turn = await this.store.update((state) => {
      const chat = this.conversation(state, params.conversationId);
      this.validateDeepThink(chat.provider, params.deepThink);
      const deepThink = params.deepThink ?? chat.deepThink;
      this.validateDeepThink(chat.provider, deepThink);
      const existing = Object.values(state.turns).find((turn) => turn.conversationId === params.conversationId && turn.requestId === params.requestId);
      if (existing) {
        if (existing.input !== params.input || existing.timeoutMs !== timeoutMs || existing.deepThink !== deepThink) throw new RuntimeError("REQUEST_CONFLICT", "requestId was already used with different input, timeout or DeepThink setting");
        return existing;
      }
      if (chat.closed) throw new RuntimeError("CHAT_CLOSED", "Resume the chat before sending");
      if (chat.needsReview) throw new RuntimeError("REVIEW_REQUIRED", "Inspect the uncertain turn and explicitly acknowledge it before sending again");
      if (Object.keys(state.turns).length >= 4096) throw new RuntimeError("CAPACITY", "Turn retention limit reached");
      const turn: Turn = { id: randomUUID(), conversationId: chat.id, requestId: params.requestId,
        input: params.input, timeoutMs, ...(deepThink === undefined ? {} : { deepThink }), status: "queued", text: "", events: [], createdAt: new Date().toISOString() };
      this.append(turn, "queued");
      state.turns[turn.id] = turn;
      return turn;
    });
    this.schedule();
    return turn;
  }

  private validateDeepThink(provider: string, value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== "boolean") throw new RuntimeError("INVALID_PARAMS", "deepThink must be boolean");
    if (provider !== "deepseek") throw new RuntimeError("INVALID_PARAMS", "DeepThink is only supported on DeepSeek");
  }

  async cancel(id: string): Promise<Turn> {
    const wasStarting = this.getTurn(id).status === "starting";
    const turn = await this.store.update((state) => {
      const turn = this.turn(state, id);
      if (isTerminal(turn.status) || turn.status === "cancelling") return turn;
      turn.status = turn.status === "queued" ? "cancelled" : "cancelling";
      this.append(turn, turn.status);
      return turn;
    });
    this.publish(turn.events.at(-1)!);
    if (turn.status === "cancelling") {
      this.workers.get(turn.conversationId)?.worker.cancel();
      if (wasStarting) await this.drop(turn.conversationId);
    }
    this.schedule();
    return turn;
  }

  history(id: string, after = 0): TurnEvent[] {
    if (!Number.isInteger(after) || after < 0) throw new RuntimeError("INVALID_PARAMS", "after must be a nonnegative sequence");
    return this.getTurn(id).events.filter((event) => event.seq > after);
  }
  subscribe(id: string, listener: (event: TurnEvent) => void): () => void {
    this.getTurn(id);
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }
  private publish(event: TurnEvent): void { this.events.emit(event.turnId, event); }
  private append(turn: Turn, type: TurnEvent["type"], extra: Partial<TurnEvent> = {}): TurnEvent {
    const event: TurnEvent = { seq: turn.events.length + 1, turnId: turn.id, type, at: new Date().toISOString(), ...extra };
    turn.events.push(event);
    return event;
  }
  private async remember(id: string, result: WorkerResult): Promise<void> {
    await this.store.update((state) => {
      const chat = this.conversation(state, id);
      if (result.url) chat.url = result.url;
      if (result.providerConversationId) chat.providerConversationId = result.providerConversationId;
    });
  }

  private schedule(): void {
    if (this.scheduled || this.stopping) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const state = this.store.read();
      for (const turn of Object.values(state.turns)) {
        if (this.busy.size >= this.maxWorkers) break;
        const chat = state.conversations[turn.conversationId]!;
        if (turn.status !== "queued" || this.busy.has(chat.id) || chat.closed || chat.needsReview) continue;
        if (!this.workers.has(chat.id) && this.workers.size >= this.maxWorkers && ![...this.workers.keys()].some((id) => this.canEvict(id))) continue;
        const sameAccount = [...this.active.keys()].filter((id) => {
          const other = state.conversations[state.turns[id]!.conversationId]!;
          return other.provider === chat.provider && other.accountId === chat.accountId;
        }).length;
        if (sameAccount >= this.perAccountConcurrency) continue;
        this.busy.add(chat.id);
        const job = Promise.resolve().then(() => this.run(turn.id)).catch(async (error) => {
          // Stop accepting work if state cannot be persisted. Leave durable state for reconciliation.
          this.failure = String(error.message ?? error);
          this.stopping = true;
          await Promise.allSettled([...this.workers.keys()].map((id) => this.drop(id)));
        }).finally(() => {
          this.active.delete(turn.id);
          this.busy.delete(chat.id);
          this.schedule();
        });
        this.active.set(turn.id, job);
      }
    });
  }

  private canEvict(id: string): boolean {
    if (this.busy.has(id) || this.closing.has(id) || this.workers.get(id)?.pinned) return false;
    const chat = this.get(id);
    return !!chat.url || !Object.values(this.store.read().turns).some((turn) => turn.conversationId === id && turn.status === "completed");
  }

  private async acquire(conversation: Conversation): Promise<ChatWorker> {
    const run = this.allocation.then(async () => {
      if (this.stopping) throw new RuntimeError("SHUTTING_DOWN", "Runtime is shutting down");
      let existing = this.workers.get(conversation.id);
      if (existing && existing.headless !== conversation.headless) { await this.drop(conversation.id); existing = undefined; }
      if (existing) { existing.used = Date.now(); return existing.worker; }
      if (this.workers.size >= this.maxWorkers) {
        const idle = [...this.workers].filter(([id]) => this.canEvict(id)).sort(([, a], [, b]) => a.used - b.used)[0];
        if (!idle) throw new RuntimeError("CAPACITY", "All browser workers are busy or holding a login window");
        await this.drop(idle[0]);
      }
      if (!conversation.url && Object.values(this.store.read().turns).some((turn) => turn.conversationId === conversation.id && turn.status === "completed")) {
        throw new RuntimeError("RESUME_UNSUPPORTED", "This chat has no saved conversation URL; refusing to open a fresh conversation");
      }
      if (this.stopping) throw new RuntimeError("SHUTTING_DOWN", "Runtime is shutting down");
      const worker = (this.options.workerFactory ?? ((config) => new BrowserWorker(config)))({
        conversation, profileDir: path.join(this.options.directory, "profiles", conversation.id),
        site: this.sites.find((site) => site.name === conversation.provider)!,
        executablePath: this.options.executablePath, channel: this.options.channel,
      });
      this.workers.set(conversation.id, { worker, used: Date.now(), headless: conversation.headless, pinned: false });
      return worker;
    });
    this.allocation = run.catch(() => undefined);
    return run;
  }
  private async drop(id: string): Promise<void> {
    const entry = this.workers.get(id);
    this.workers.delete(id);
    await entry?.worker.close();
  }

  private async notice(id: string, notice: WorkerNotice): Promise<void> {
    const event = await this.store.update((state) => {
      const turn = this.turn(state, id);
      if (isTerminal(turn.status)) return undefined;
      const chat = this.conversation(state, turn.conversationId);
      if (notice.url) chat.url = notice.url;
      if (notice.type === "submitting") {
        if (turn.status !== "cancelling") turn.status = "submitting";
        return this.append(turn, "submitting");
      }
      const text = notice.text ?? "";
      if (text === turn.text) return undefined;
      if (text.length > 1_000_000 || turn.events.length > 2000) throw new RuntimeError("RESPONSE_LIMIT", "Reply or event limit exceeded");
      const append = text.startsWith(turn.text);
      const delta = append ? text.slice(turn.text.length) : text;
      turn.text = text;
      if (turn.status !== "cancelling") turn.status = "streaming";
      return this.append(turn, append ? "message_delta" : "message_snapshot", { text: delta });
    });
    if (event) this.publish(event);
  }

  private async finish(id: string, status: TurnStatus, result: WorkerResult = {}, error?: string): Promise<void> {
    const event = await this.store.update((state) => {
      const turn = this.turn(state, id);
      if (isTerminal(turn.status)) return undefined;
      turn.status = status;
      if (result.text !== undefined) turn.text = result.text;
      turn.error = error;
      turn.stopConfirmed = result.stopConfirmed;
      turn.source = result.source;
      const chat = this.conversation(state, turn.conversationId);
      if (result.url) chat.url = result.url;
      if (result.providerConversationId) chat.providerConversationId = result.providerConversationId;
      if (status === "uncertain") chat.needsReview = true;
      return this.append(turn, status, { text: turn.text, error, stopConfirmed: result.stopConfirmed, source: result.source });
    });
    if (event) this.publish(event);
  }

  private async run(id: string): Promise<void> {
    let attempted = false;
    let pending: Promise<void> = Promise.resolve();
    const original = this.getTurn(id);
    try {
      const event = await this.store.update((state) => {
        const turn = this.turn(state, id);
        if (turn.status !== "queued") return undefined;
        turn.status = "starting";
        return this.append(turn, "starting");
      });
      if (!event) return;
      this.publish(event);
      const chat = this.get(original.conversationId);
      const worker = await this.acquire(chat);
      if (this.getTurn(id).status === "cancelling") { await this.finish(id, "cancelled"); return; }
      const opened = await worker.open();
      await this.remember(chat.id, opened);
      if (this.getTurn(id).status === "cancelling") { await this.finish(id, "cancelled"); return; }
      this.workers.get(chat.id)!.pinned = false;
      const result = await worker.send(original.input, original.timeoutMs, (notice) => {
        if (notice.type === "submitting") attempted = true;
        pending = pending.then(() => this.notice(id, notice));
        void pending.catch(() => worker.cancel());
      }, { deepThink: original.deepThink });
      await pending;
      await this.finish(id, "completed", result);
    } catch (error: any) {
      await pending.catch(() => undefined);
      const cancelled = this.getTurn(id).status === "cancelling";
      const status = error.code === "CANCELLED" && error.stopConfirmed ? "cancelled" :
        cancelled && !attempted ? "cancelled" : attempted ? "uncertain" : "failed";
      await this.finish(id, status, { stopConfirmed: error.stopConfirmed }, String(error.message ?? error).slice(0, 1000));
      await this.drop(original.conversationId);
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    try {
      for (const turn of Object.values(this.store.read().turns)) {
        if (!isTerminal(turn.status)) await this.finish(turn.id, turn.status === "queued" ? "cancelled" : "uncertain", {}, "Runtime is shutting down");
      }
    } finally {
      await this.allocation.catch(() => undefined);
      await Promise.allSettled([...this.workers.keys()].map((id) => this.drop(id)));
      await Promise.allSettled([...this.active.values()]);
    }
  }
}
