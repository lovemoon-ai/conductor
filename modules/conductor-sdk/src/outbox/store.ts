import fs from 'node:fs';
import path from 'node:path';

const OUTBOX_DIR = path.join('.conductor', 'state');
const OUTBOX_BASENAME = 'agent-upstream-outbox';
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

export type DurableUpstreamEventType =
  | 'sdk_message'
  | 'task_status_update'
  | 'agent_command_ack'
  | 'task_stop_ack';

export interface DurableUpstreamEvent {
  stableId: string;
  eventType: DurableUpstreamEventType;
  payload: Record<string, unknown>;
  createdAt: string;
  attemptCount: number;
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null;
}

type DurableUpstreamOutboxPayload = {
  entries: DurableUpstreamEvent[];
};

const sleepSync = (ms: number): void => {
  if (ms <= 0) return;
  try {
    const buffer = new SharedArrayBuffer(4);
    const arr = new Int32Array(buffer);
    Atomics.wait(arr, 0, 0, ms);
  } catch {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ms) {
      // busy wait fallback
    }
  }
};

const sanitizeScopeId = (scopeId: string): string =>
  scopeId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'default';

export class DurableUpstreamOutboxStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
  }

  static filePathForProjectPath(projectPath: string, scopeId: string): string {
    return path.join(
      projectPath,
      OUTBOX_DIR,
      `${OUTBOX_BASENAME}.${sanitizeScopeId(scopeId)}.json`,
    );
  }

  static forProjectPath(projectPath: string, scopeId: string): DurableUpstreamOutboxStore {
    return new DurableUpstreamOutboxStore(
      DurableUpstreamOutboxStore.filePathForProjectPath(projectPath, scopeId),
    );
  }

  load(): DurableUpstreamEvent[] {
    return this.withLock(() => this.loadUnlocked());
  }

  upsert(entry: {
    stableId: string;
    eventType: DurableUpstreamEventType;
    payload: Record<string, unknown>;
  }): DurableUpstreamEvent {
    return this.withLock(() => {
      const entries = this.loadUnlocked();
      const existing = entries.find((candidate) => candidate.stableId === entry.stableId);
      const record: DurableUpstreamEvent = {
        stableId: entry.stableId,
        eventType: entry.eventType,
        payload: entry.payload,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        attemptCount: existing?.attemptCount ?? 0,
        lastAttemptAt: existing?.lastAttemptAt ?? null,
        nextAttemptAt: existing?.nextAttemptAt ?? new Date().toISOString(),
      };
      const nextEntries = existing
        ? entries.map((candidate) => (candidate.stableId === entry.stableId ? record : candidate))
        : [...entries, record];
      this.saveUnlocked(nextEntries);
      return record;
    });
  }

  remove(stableId: string): void {
    this.withLock(() => {
      const entries = this.loadUnlocked().filter((candidate) => candidate.stableId !== stableId);
      this.saveUnlocked(entries);
    });
  }

  markRetry(stableId: string, delayMs: number): DurableUpstreamEvent | null {
    return this.withLock(() => {
      const entries = this.loadUnlocked();
      const index = entries.findIndex((candidate) => candidate.stableId === stableId);
      if (index < 0) {
        return null;
      }
      const now = Date.now();
      const updated: DurableUpstreamEvent = {
        ...entries[index],
        attemptCount: entries[index].attemptCount + 1,
        lastAttemptAt: new Date(now).toISOString(),
        nextAttemptAt: new Date(now + Math.max(delayMs, 0)).toISOString(),
      };
      entries[index] = updated;
      this.saveUnlocked(entries);
      return updated;
    });
  }

  listReady(nowMs: number = Date.now()): DurableUpstreamEvent[] {
    return this.load()
      .filter((entry) => {
        if (!entry.nextAttemptAt) return true;
        const nextAttemptMs = Date.parse(entry.nextAttemptAt);
        return !Number.isFinite(nextAttemptMs) || nextAttemptMs <= nowMs;
      });
  }

  nextRetryDelay(nowMs: number = Date.now()): number | null {
    const entries = this.load();
    let minDelay: number | null = null;
    for (const entry of entries) {
      if (!entry.nextAttemptAt) {
        return 0;
      }
      const nextAttemptMs = Date.parse(entry.nextAttemptAt);
      if (!Number.isFinite(nextAttemptMs)) {
        return 0;
      }
      const delay = Math.max(nextAttemptMs - nowMs, 0);
      minDelay = minDelay === null ? delay : Math.min(minDelay, delay);
    }
    return minDelay;
  }

  private loadUnlocked(): DurableUpstreamEvent[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    try {
      const contents = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(contents) as DurableUpstreamOutboxPayload;
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private saveUnlocked(entries: DurableUpstreamEvent[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: DurableUpstreamOutboxPayload = { entries };
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    const release = this.acquireLock();
    try {
      return fn();
    } finally {
      release();
    }
  }

  private acquireLock(): () => void {
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        return () => {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            // ignore
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw error;
        }
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for outbox lock: ${this.lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }
}
