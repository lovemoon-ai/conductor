import type { Project } from '@/shared/types';

/**
 * Memo entries are stored inside `project.metadata.memos` as an immutable list
 * so we don't need a dedicated table for what is essentially a free-form
 * notebook. Each memo carries its own id so the UI can target a specific row
 * for deletion without relying on array indices that shift when we sort.
 *
 * Known limitation — last-write-wins: multiple clients editing memos on the
 * same project will overwrite each other because we PATCH the whole metadata
 * blob. The collaboration product surface is small today (one user typically
 * owns a project) so we accept the trade-off; a future "shared memo" feature
 * would need a dedicated `ProjectMemo` row per entry.
 */
export interface ProjectMemo {
  id: string;
  content: string;
  createdAt: string;
}

/** Per-memo soft cap. Keeps the UI scannable and metadata bounded. */
export const MAX_MEMO_CONTENT_CHARS = 5000;
/** Total memo cap per project — protects the 256 KiB metadata budget. */
export const MAX_MEMOS_PER_PROJECT = 200;

const isProjectMemo = (value: unknown): value is ProjectMemo => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string'
    && typeof record.content === 'string'
    && typeof record.createdAt === 'string'
  );
};

export const readProjectMemos = (project: Project): ProjectMemo[] => {
  const metadata = project.metadata;
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>).memos;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isProjectMemo);
};

/**
 * Merge memos back into the existing metadata so we don't accidentally drop
 * sibling keys (e.g. `bindingCandidate`) when patching the project.
 */
export const buildMetadataWithMemos = (
  project: Project,
  memos: ProjectMemo[],
): Record<string, unknown> => {
  const existing =
    project.metadata && typeof project.metadata === 'object'
      ? { ...(project.metadata as Record<string, unknown>) }
      : {};
  existing.memos = memos;
  return existing;
};

export const pad2 = (n: number) => n.toString().padStart(2, '0');

/**
 * Format an ISO timestamp as a compact "YYYY-MM-DD HH:mm" string. Falls back
 * to the raw value when parsing fails so we don't render "Invalid Date" to the
 * user (e.g. for legacy records or malformed metadata).
 */
export const formatTimestamp = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

export const githubProjectLink = (
  gitRemoteUrl: string | null | undefined,
): { label: string; href: string } | null => {
  if (!gitRemoteUrl) return null;
  const normalized = gitRemoteUrl
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'github.com') {
    return null;
  }
  const label = parts.slice(0, 3).join('/');
  return {
    label,
    href: `https://${label}`,
  };
};

export const generateMemoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
