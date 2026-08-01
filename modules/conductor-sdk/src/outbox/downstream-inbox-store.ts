import fs from 'node:fs';
import path from 'node:path';

import type { DownstreamCommandCursor } from './downstream-cursor-store.js';

const STATE_DIR = path.join('.conductor', 'state');
const BASENAME = 'agent-downstream-inbox';

export interface DurableDownstreamCommand {
  requestId: string;
  taskId: string;
  cursor: DownstreamCommandCursor;
  envelope: Record<string, unknown>;
  attemptCount: number;
  nextAttemptAt: string;
}

function isDurableCommand(value: unknown): value is DurableDownstreamCommand {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DurableDownstreamCommand>;
  return typeof entry.requestId === 'string' && Boolean(entry.requestId.trim())
    && typeof entry.taskId === 'string' && Boolean(entry.taskId.trim())
    && Boolean(entry.cursor) && typeof entry.cursor?.createdAt === 'string' && typeof entry.cursor?.requestId === 'string'
    && Boolean(entry.envelope) && typeof entry.envelope === 'object'
    && Number.isSafeInteger(entry.attemptCount) && (entry.attemptCount ?? -1) >= 0
    && typeof entry.nextAttemptAt === 'string';
}

const sanitizeScopeId = (value: string): string => value.trim().replace(/[^A-Za-z0-9._-]+/g, '_') || 'default';

export class DownstreamInboxStore {
  constructor(private readonly filePath: string) {}

  static forProjectPath(projectPath: string, scopeId: string): DownstreamInboxStore {
    return new DownstreamInboxStore(path.join(projectPath, STATE_DIR, `${BASENAME}.${sanitizeScopeId(scopeId)}.json`));
  }

  list(): DurableDownstreamCommand[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { entries?: DurableDownstreamCommand[] };
      if (!Array.isArray(parsed.entries)) throw new Error(`Invalid downstream inbox: ${this.filePath}`);
      if (!parsed.entries.every(isDurableCommand)) throw new Error(`Invalid downstream inbox entry: ${this.filePath}`);
      return parsed.entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  upsert(command: Omit<DurableDownstreamCommand, 'attemptCount' | 'nextAttemptAt'>): DurableDownstreamCommand {
    const entries = this.list();
    const existing = entries.find((entry) => entry.requestId === command.requestId);
    if (existing) return existing;
    const entry = { ...command, attemptCount: 0, nextAttemptAt: new Date().toISOString() };
    this.save([...entries, entry]);
    return entry;
  }

  import(entry: DurableDownstreamCommand): DurableDownstreamCommand {
    const entries = this.list();
    const existing = entries.find((candidate) => candidate.requestId === entry.requestId);
    if (existing) return existing;
    this.save([...entries, entry]);
    return entry;
  }

  markRetry(requestId: string, delayMs: number): void {
    const entries = this.list().map((entry) => entry.requestId === requestId ? {
      ...entry,
      attemptCount: entry.attemptCount + 1,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
    } : entry);
    this.save(entries);
  }

  remove(requestId: string): void {
    this.save(this.list().filter((entry) => entry.requestId !== requestId));
  }

  private save(entries: DurableDownstreamCommand[]): void {
    const resolved = path.resolve(this.filePath);
    const directory = path.dirname(resolved);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ entries }, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, resolved);
    const directoryFd = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
}
