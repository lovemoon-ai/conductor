import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'yaml';
import { type ConductorPathEnv, resolveConductorHome } from '../paths.js';

export const DEFAULT_SESSION_DIR = path.join(resolveConductorHome(), 'sessions');
export const DEFAULT_SESSION_PATH = path.join(resolveConductorHome(), 'session.yaml');
export const DEFAULT_SESSION_ENV = 'CODEX_SESSION_ID';
export const DEFAULT_SESSION_FALLBACK_ENV = 'SESSION_ID';
const SESSION_LOCK_TIMEOUT_MS = 10_000;
const SESSION_LOCK_RETRY_MS = 50;

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

export interface SessionRecordInit {
  projectId: string;
  taskIds: string[];
  projectPath: string;
  sessionId?: string | null;
  sessionFilePath?: string | null;
  backendType?: string | null;
  hostname?: string | null;
}

export class SessionRecord {
  public projectId: string;
  public taskIds: string[];
  public projectPath: string;
  public sessionId?: string | null;
  public sessionFilePath?: string | null;
  public backendType?: string | null;
  public hostname?: string | null;

  constructor(init: SessionRecordInit) {
    this.projectId = init.projectId;
    this.taskIds = init.taskIds;
    this.projectPath = init.projectPath;
    this.sessionId = init.sessionId ?? null;
    this.sessionFilePath = init.sessionFilePath ?? null;
    this.backendType = init.backendType ?? null;
    this.hostname = init.hostname ?? null;
  }

  static fromJSON(payload: Record<string, any>): SessionRecord {
    const projectId = payload.project_id ? String(payload.project_id) : '';
    const projectPath = payload.project_path ? String(payload.project_path) : '';
    if (!projectId || !projectPath) {
      throw new Error('Session record missing project_id or project_path');
    }
    const rawTasks = payload.task_id || payload.task_ids || [];
    const taskIds = Array.isArray(rawTasks)
      ? rawTasks.map((task) => String(task)).filter(Boolean)
      : typeof rawTasks === 'string'
        ? [rawTasks]
        : [];
    const sessionId = payload.session_id ? String(payload.session_id) : null;
    const sessionFilePath = payload.session_file_path ? String(payload.session_file_path) : null;
    const backendType = payload.backend_type ? String(payload.backend_type) : null;
    const hostname = payload.hostname ? String(payload.hostname) : null;
    return new SessionRecord({
      projectId,
      projectPath,
      taskIds,
      sessionId,
      sessionFilePath,
      backendType,
      hostname,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      project_id: this.projectId,
      task_id: Array.from(this.taskIds),
      project_path: this.projectPath,
      session_id: this.sessionId,
      session_file_path: this.sessionFilePath,
      backend_type: this.backendType,
      hostname: this.hostname,
    };
  }
}

export class SessionDiskStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath: string = path.join(resolveConductorHome(), 'session.yaml')) {
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
  }

  /**
   * Create a SessionDiskStore for a specific backend URL.
   * Sessions are stored in $CONDUCTOR_HOME/sessions/<host>.yaml.
   * When CONDUCTOR_HOME is unset, it defaults to ~/.conductor.
   */
  static forBackendUrl(backendUrl: string, env: ConductorPathEnv = process.env): SessionDiskStore {
    const host = extractHostKey(backendUrl);
    const filePath = path.join(resolveConductorHome(env), 'sessions', `${host}.yaml`);
    return new SessionDiskStore(filePath);
  }

  load(): SessionRecord[] {
    return this.withLock(() => this.loadUnlocked());
  }

  private loadUnlocked(): SessionRecord[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    try {
      const contents = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = yaml.parse(contents) ?? {};
      const entries = Array.isArray(parsed.sessions) ? parsed.sessions : parsed;
      if (!entries || typeof entries !== 'object') {
        return [];
      }
      const list: SessionRecord[] = [];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry === 'object') {
            try {
              list.push(SessionRecord.fromJSON(entry));
            } catch {
              continue;
            }
          }
        }
      } else if (Array.isArray((entries as any).sessions)) {
        for (const entry of (entries as any).sessions) {
          if (entry && typeof entry === 'object') {
            try {
              list.push(SessionRecord.fromJSON(entry));
            } catch {
              continue;
            }
          }
        }
      }
      return list;
    } catch {
      return [];
    }
  }

  save(records: SessionRecord[]): void {
    this.withLock(() => this.saveUnlocked(records));
  }

  private saveUnlocked(records: SessionRecord[]): void {
    const payload = {
      sessions: records.map((record) => record.toJSON()),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, yaml.stringify(payload), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }

  findByPath(projectPath: string): SessionRecord | undefined {
    const normalized = path.resolve(projectPath);
    return this.load().find((record) => path.resolve(record.projectPath) === normalized);
  }

  findByTaskId(taskId: string): SessionRecord | undefined {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      return undefined;
    }
    return this.load().find((record) => record.taskIds.includes(normalizedTaskId));
  }

  upsert(params: {
    projectId: string;
    taskId: string;
    projectPath: string;
    sessionId?: string | null;
    sessionFilePath?: string | null;
    backendType?: string | null;
    hostname?: string | null;
  }): SessionRecord {
    const normalizedTaskId = String(params.taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('taskId is required');
    }

    const normalizedPath = path.resolve(params.projectPath);
    return this.withLock(() => {
      const records = this.loadUnlocked();
      let record = records.find((entry) => entry.taskIds.includes(normalizedTaskId));
      if (!record) {
        record = new SessionRecord({
          projectId: params.projectId,
          taskIds: [normalizedTaskId],
          projectPath: normalizedPath,
          sessionId: params.sessionId ?? null,
          sessionFilePath: params.sessionFilePath ?? null,
          backendType: params.backendType ?? null,
          hostname: params.hostname,
        });
        records.push(record);
      } else {
        record.projectId = params.projectId;
        record.projectPath = normalizedPath;
        if (!record.taskIds.includes(normalizedTaskId)) {
          record.taskIds.push(normalizedTaskId);
        }
        if (params.sessionId !== undefined) {
          const normalizedSessionId = String(params.sessionId || '').trim();
          record.sessionId = normalizedSessionId || null;
        }
        if (params.sessionFilePath !== undefined) {
          const normalizedSessionFilePath = String(params.sessionFilePath || '').trim();
          record.sessionFilePath = normalizedSessionFilePath || null;
        }
        if (params.backendType !== undefined) {
          const normalizedBackendType = String(params.backendType || '').trim();
          record.backendType = normalizedBackendType || null;
        }
        if (params.hostname !== undefined) {
          const normalizedHostname = String(params.hostname || '').trim();
          record.hostname = normalizedHostname || null;
        }
      }
      this.saveUnlocked(records);
      return record;
    });
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
            // ignore close failure
          }
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            // ignore unlink failure
          }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw error;
        }
        if (Date.now() - startedAt > SESSION_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for session store lock: ${this.lockPath}`);
        }
        sleepSync(SESSION_LOCK_RETRY_MS);
      }
    }
  }
}

export function currentSessionId(env: Record<string, string | undefined> = process.env): string | undefined {
  return env[DEFAULT_SESSION_ENV] || env[DEFAULT_SESSION_FALLBACK_ENV];
}

export function currentHostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}

/**
 * Extract a safe filename key from a backend URL.
 * e.g., "http://localhost:6152" -> "localhost_6152"
 *       "https://conductor-ai.top" -> "conductor-ai.top"
 */
function extractHostKey(backendUrl: string): string {
  try {
    const url = new URL(backendUrl);
    const host = url.hostname;
    const port = url.port;
    // Replace unsafe characters for filenames
    const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, '_');
    return port ? `${safeHost}_${port}` : safeHost;
  } catch {
    // Fallback: sanitize the entire URL
    return backendUrl.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 50);
  }
}
