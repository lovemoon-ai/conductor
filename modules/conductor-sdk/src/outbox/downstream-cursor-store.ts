import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = path.join('.conductor', 'state');
const CURSOR_BASENAME = 'agent-downstream-cursor';

export interface DownstreamCommandCursor {
  createdAt: string;
  requestId: string;
}

type DownstreamCursorState = {
  agents: Record<string, DownstreamCommandCursor>;
};

function normalizeCursorValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function compareCursor(left: DownstreamCommandCursor, right: DownstreamCommandCursor): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const normalizedLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRightTime = Number.isFinite(rightTime) ? rightTime : 0;
  if (normalizedLeftTime !== normalizedRightTime) {
    return normalizedLeftTime < normalizedRightTime ? -1 : 1;
  }
  return left.requestId.localeCompare(right.requestId);
}

const sanitizeScopeId = (scopeId: string): string =>
  scopeId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'default';

export function normalizeDownstreamCommandCursor(value: unknown): DownstreamCommandCursor | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const source = value as {
    created_at?: unknown;
    createdAt?: unknown;
    request_id?: unknown;
    requestId?: unknown;
  };
  const createdAt = normalizeCursorValue(source.created_at) ?? normalizeCursorValue(source.createdAt);
  const requestId = normalizeCursorValue(source.request_id) ?? normalizeCursorValue(source.requestId);
  if (!createdAt || !requestId) {
    return null;
  }
  return {
    createdAt,
    requestId,
  };
}

export class DownstreamCursorStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  static filePathForProjectPath(projectPath: string, scopeId: string): string {
    return path.join(
      projectPath,
      STATE_DIR,
      `${CURSOR_BASENAME}.${sanitizeScopeId(scopeId)}.json`,
    );
  }

  static forProjectPath(projectPath: string, scopeId: string): DownstreamCursorStore {
    return new DownstreamCursorStore(
      DownstreamCursorStore.filePathForProjectPath(projectPath, scopeId),
    );
  }

  get(agentHost: string): DownstreamCommandCursor | null {
    const state = this.loadState();
    return state.agents[agentHost] ?? null;
  }

  hasApplied(agentHost: string, cursor: DownstreamCommandCursor): boolean {
    const current = this.get(agentHost);
    if (!current) {
      return false;
    }
    return compareCursor(current, cursor) >= 0;
  }

  advance(agentHost: string, cursor: DownstreamCommandCursor): DownstreamCommandCursor {
    const state = this.loadState();
    const current = state.agents[agentHost] ?? null;
    if (current && compareCursor(current, cursor) >= 0) {
      return current;
    }
    state.agents[agentHost] = cursor;
    this.saveState(state);
    return cursor;
  }

  private loadState(): DownstreamCursorState {
    if (!fs.existsSync(this.filePath)) {
      return { agents: {} };
    }
    try {
      const contents = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(contents) as DownstreamCursorState;
      if (!parsed || typeof parsed !== 'object' || !parsed.agents || typeof parsed.agents !== 'object') {
        return { agents: {} };
      }
      return { agents: parsed.agents };
    } catch {
      return { agents: {} };
    }
  }

  private saveState(state: DownstreamCursorState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }
}
