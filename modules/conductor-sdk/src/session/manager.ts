import { EventEmitter } from 'node:events';

type JsonRecord = Record<string, unknown>;

export interface MessageInput {
  messageId: string;
  role: string;
  content: string;
  ackToken?: string | null;
  metadata?: JsonRecord | null;
  attachments?: JsonRecord[];
}

function normalizeJsonRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return { ...(value as JsonRecord) };
}

function normalizeJsonRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is JsonRecord => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({ ...entry }));
}

export class MessageRecord {
  public readonly messageId: string;
  public readonly role: string;
  public readonly content: string;
  public readonly createdAt: Date;
  public readonly ackToken?: string | null;
  public readonly metadata?: JsonRecord | null;
  public readonly attachments: JsonRecord[];

  constructor(init: MessageInput) {
    this.messageId = init.messageId;
    this.role = init.role;
    this.content = init.content;
    this.ackToken = init.ackToken;
    this.metadata = normalizeJsonRecord(init.metadata);
    this.attachments = normalizeJsonRecordArray(init.attachments);
    this.createdAt = new Date();
  }
}

export class SessionState {
  public lastMessageAt: Date;
  public status = 'ACTIVE';
  public pendingMessages: MessageRecord[] = [];
  public ackToken: string | null = null;

  constructor(
    public readonly taskId: string,
    public readonly sessionId: string,
    public readonly projectId: string,
    public readonly createdAt: Date = new Date(),
  ) {
    this.lastMessageAt = createdAt;
  }
}

class AsyncLock {
  private readonly emitter = new EventEmitter();
  private tail = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run
      .then(() => undefined)
      .catch(() => undefined);
    return run;
  }
}

class MessageEvent {
  private waiter: Promise<void>;
  private resolver: (() => void) | null = null;

  constructor() {
    this.waiter = this.reset();
  }

  async wait(): Promise<void> {
    await this.waiter;
  }

  signal(): void {
    this.resolver?.();
    this.waiter = this.reset();
  }

  clear(): void {
    this.waiter = this.reset();
  }

  private reset(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly lock = new AsyncLock();
  private readonly messageEvents = new Map<string, MessageEvent>();

  async addSession(taskId: string, sessionId: string, projectId: string): Promise<SessionState> {
    return this.lock.runExclusive(async () => {
      const state = new SessionState(taskId, sessionId, projectId);
      this.sessions.set(taskId, state);
      this.messageEvents.set(taskId, new MessageEvent());
      return state;
    });
  }

  async getSession(taskId: string): Promise<SessionState | undefined> {
    return this.lock.runExclusive(async () => this.sessions.get(taskId));
  }

  async addMessage(taskId: string, message: MessageInput): Promise<void> {
    await this.lock.runExclusive(async () => {
      const session = this.sessions.get(taskId);
      if (!session) {
        return;
      }
      const record = new MessageRecord(message);
      session.pendingMessages.push(record);
      session.lastMessageAt = record.createdAt;
      this.ensureEvent(taskId).signal();
    });
  }

  async popMessages(taskId: string, limit = 20): Promise<MessageRecord[]> {
    return this.lock.runExclusive(async () => {
      const session = this.sessions.get(taskId);
      if (!session) {
        return [];
      }
      const items: MessageRecord[] = [];
      while (session.pendingMessages.length && items.length < limit) {
        const next = session.pendingMessages.shift();
        if (next) {
          items.push(next);
        }
      }
      if (items.length) {
        session.ackToken = items[items.length - 1].ackToken ?? null;
      }
      const event = this.ensureEvent(taskId);
      if (session.pendingMessages.length) {
        event.signal();
      } else {
        event.clear();
      }
      return items;
    });
  }

  async waitForMessages(taskId: string, limit = 20): Promise<MessageRecord[]> {
    const event = this.ensureEvent(taskId);
    // Loop until a batch is available.
    while (true) {
      const messages = await this.popMessages(taskId, limit);
      if (messages.length) {
        return messages;
      }
      await event.wait();
    }
  }

  async ack(taskId: string, ackToken: string): Promise<boolean> {
    return this.lock.runExclusive(async () => {
      const session = this.sessions.get(taskId);
      if (!session) {
        return false;
      }
      if (session.ackToken && session.ackToken === ackToken) {
        session.ackToken = null;
        return true;
      }
      return false;
    });
  }

  async listSessions(): Promise<SessionState[]> {
    return this.lock.runExclusive(async () => Array.from(this.sessions.values()));
  }

  async endSession(taskId: string): Promise<void> {
    await this.lock.runExclusive(async () => {
      const session = this.sessions.get(taskId);
      if (session) {
        session.status = 'ENDED';
      }
    });
  }

  private ensureEvent(taskId: string): MessageEvent {
    let event = this.messageEvents.get(taskId);
    if (!event) {
      event = new MessageEvent();
      this.messageEvents.set(taskId, event);
    }
    return event;
  }
}
