/**
 * Mapping helpers between Conductor's snake_case REST payloads and the SDK's
 * camelCase type surface. Intentionally explicit (no deep auto-conversion) so
 * field renames are caught at compile time.
 */
import type { Project } from '../types/project.js';
import type { Task } from '../types/task.js';
import type { Message, Attachment } from '../types/message.js';

type Raw = Record<string, unknown>;

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const num = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
};

const bool = (value: unknown): boolean => Boolean(value);

const pick = (raw: Raw, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
  }
  return undefined;
};

const isoDate = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  // Fall back to the epoch instead of '' so downstream `Date.parse` returns
  // a finite number and the dedupSorted comparator stays well-defined.
  return new Date(0).toISOString();
};

export function normalizeProject(raw: unknown): Project {
  const r = (raw ?? {}) as Raw;
  const metadata = (pick(r, 'metadata') ?? null) as Raw | null;
  const ownership =
    metadata && typeof metadata === 'object'
      ? ((metadata as Raw).ownership as Raw | undefined)
      : undefined;
  const audit =
    metadata && typeof metadata === 'object'
      ? ((metadata as Raw).audit as Raw | undefined)
      : undefined;
  const createdByApp =
    Boolean(ownership && ownership.kind === 'app') ||
    Boolean(audit && audit.createdByApp);

  return {
    id: str(pick(r, 'id')) ?? '',
    name: str(pick(r, 'name')) ?? '',
    daemonHost: str(pick(r, 'daemonHost', 'daemon_host')),
    workspacePath: str(pick(r, 'workspacePath', 'workspace_path')),
    repoRoot: str(pick(r, 'repoRoot', 'repo_root')),
    worktreeBranch: str(pick(r, 'worktreeBranch', 'worktree_branch')),
    lastCommit: str(pick(r, 'lastCommit', 'last_commit')),
    lastCommitAt: str(pick(r, 'lastCommitAt', 'last_commit_at')),
    fileCount: num(pick(r, 'fileCount', 'file_count')),
    isDefault: bool(pick(r, 'isDefault', 'is_default')),
    createdByApp,
    createdAt: isoDate(pick(r, 'createdAt', 'created_at')),
    updatedAt: isoDate(pick(r, 'updatedAt', 'updated_at')),
  };
}

export function normalizeTask(raw: unknown): Task {
  const r = (raw ?? {}) as Raw;
  return {
    id: str(pick(r, 'id')) ?? '',
    projectId: str(pick(r, 'projectId', 'project_id')) ?? '',
    title: str(pick(r, 'title')) ?? '',
    status: (str(pick(r, 'status')) ?? 'pending') as Task['status'],
    backendType: str(pick(r, 'backendType', 'backend_type')),
    sessionId: str(pick(r, 'sessionId', 'session_id')),
    sessionFilePath: str(pick(r, 'sessionFilePath', 'session_file_path')),
    createdAt: isoDate(pick(r, 'createdAt', 'created_at')),
    updatedAt: isoDate(pick(r, 'updatedAt', 'updated_at')),
  };
}

export function normalizeMessage(raw: unknown): Message {
  const r = (raw ?? {}) as Raw;
  const metadata = pick(r, 'metadata');
  const rawAttachments = pick(r, 'attachments');
  const attachments: Attachment[] = Array.isArray(rawAttachments)
    ? rawAttachments.map((a) => normalizeAttachment(a))
    : [];
  return {
    id: str(pick(r, 'id')) ?? '',
    taskId: str(pick(r, 'taskId', 'task_id')) ?? '',
    role: (str(pick(r, 'role')) ?? 'sdk') as Message['role'],
    content: typeof r.content === 'string' ? r.content : '',
    metadata:
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : null,
    attachments,
    createdAt: isoDate(pick(r, 'createdAt', 'created_at')),
  };
}

export function normalizeAttachment(raw: unknown): Attachment {
  const r = (raw ?? {}) as Raw;
  return {
    id: str(pick(r, 'id')) ?? '',
    filename: str(pick(r, 'filename', 'name')) ?? '',
    mimeType: str(pick(r, 'mimeType', 'mime_type', 'contentType', 'content_type')) ?? 'application/octet-stream',
    sizeBytes: num(pick(r, 'sizeBytes', 'size_bytes', 'size')) ?? 0,
    url: str(pick(r, 'url')) ?? '',
  };
}
