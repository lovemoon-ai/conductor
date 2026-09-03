import { ApiRequestError } from '@/shared/api/client';

// Local types for `GET /api/agents/[host]/sessions`. Kept in this feature file
// (instead of `@/shared/types`) to avoid concurrent edits with the server-side
// work; converge into shared types later.
export interface DaemonSessionSummary {
  backend: string;
  sessionId: string;
  sessionFilePath: string | null;
  cwd: string | null;
  title: string | null;
  /** ISO timestamp of the session's last activity, when known. */
  updatedAt: string | null;
  /** Existing task already resumed from this session, if any. */
  linkedTaskId: string | null;
  projectId: string | null;
}

export interface DaemonSessionsBackendError {
  backend: string;
  message: string;
}

/** Backends the resume flow asks the daemon to list. */
export const RESUME_SESSION_BACKENDS = ['claude', 'codex', 'kimi'];

/** A session is "active" when its last activity is under 2 minutes old. */
export const ACTIVE_SESSION_WINDOW_MS = 2 * 60 * 1000;

const RESUME_TITLE_MAX_LENGTH = 60;

const pickString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Accept both snake_case (API contract) and camelCase fields. */
export const normalizeDaemonSession = (raw: unknown): DaemonSessionSummary | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const backend = pickString(record.backend);
  const sessionId = pickString(record.session_id) ?? pickString(record.sessionId);
  if (!backend || !sessionId) return null;
  return {
    backend,
    sessionId,
    sessionFilePath: pickString(record.session_file_path) ?? pickString(record.sessionFilePath),
    cwd: pickString(record.cwd),
    title: pickString(record.title),
    updatedAt: pickString(record.updated_at) ?? pickString(record.updatedAt),
    linkedTaskId: pickString(record.linked_task_id) ?? pickString(record.linkedTaskId),
    projectId: pickString(record.project_id) ?? pickString(record.projectId),
  };
};

/** Last path segment of a cwd/file path ('' when unavailable). */
export const getPathTail = (path: string | null): string => {
  if (!path) return '';
  const segments = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
};

/** Display title for a session row: title, else cwd tail, else short id. */
export const sessionDisplayTitle = (session: DaemonSessionSummary): string =>
  session.title?.trim() || getPathTail(session.cwd) || session.sessionId.slice(0, 8);

/** Default title for the resumed task: truncated session title, else `Resume: <cwd tail>`. */
export const defaultResumeTaskTitle = (session: DaemonSessionSummary): string => {
  const title = session.title?.trim();
  if (title) {
    return title.length > RESUME_TITLE_MAX_LENGTH
      ? `${title.slice(0, RESUME_TITLE_MAX_LENGTH)}…`
      : title;
  }
  return `Resume: ${getPathTail(session.cwd) || session.sessionId.slice(0, 8)}`;
};

export const isSessionActive = (updatedAt: string | null, nowMs: number): boolean => {
  if (!updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return false;
  const age = nowMs - timestamp;
  return age >= 0 && age < ACTIVE_SESSION_WINDOW_MS;
};

export const formatRelativeTime = (updatedAt: string | null, nowMs: number): string => {
  if (!updatedAt) return '';
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return '';
  const deltaMs = Math.max(0, nowMs - timestamp);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

const sessionTimestamp = (session: DaemonSessionSummary): number => {
  const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
};

/**
 * Unified display order: sessions already linked to a task sink to the bottom
 * (they navigate to the existing task instead of creating a new one); within
 * each half, newest activity first.
 */
export const sortSessionsForDisplay = (
  sessions: DaemonSessionSummary[],
): DaemonSessionSummary[] =>
  [...sessions].sort((left, right) => {
    const leftLinked = left.linkedTaskId ? 1 : 0;
    const rightLinked = right.linkedTaskId ? 1 : 0;
    if (leftLinked !== rightLinked) return leftLinked - rightLinked;
    return sessionTimestamp(right) - sessionTimestamp(left);
  });

/** User-facing message for a failed session listing request. */
export const getSessionsErrorMessage = (error: unknown): string => {
  if (error instanceof ApiRequestError) {
    if (error.status === 404 && error.payload?.error === 'daemon_offline') {
      return 'Daemon is offline. Reconnect it before resuming a session.';
    }
    if (error.status === 409) {
      return 'Daemon version is outdated. Update the daemon and try again.';
    }
    if (error.status === 504) {
      return 'Daemon timed out while listing sessions. Try again.';
    }
    return error.payload?.message || error.payload?.error || 'Failed to load sessions.';
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Failed to load sessions.';
};
