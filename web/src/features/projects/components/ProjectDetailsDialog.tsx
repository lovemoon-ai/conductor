'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import type { Project } from '@/shared/types';
import { useProjectsStore } from '../store';

interface ProjectDetailsDialogProps {
  open: boolean;
  project: Project;
  /**
   * All members of the merged project group this dialog represents. When > 1,
   * a hint is shown so the user understands memos are stored per-daemon (and
   * only the primary member's memos are visible here).
   */
  mergedMembers?: Project[];
  onClose: () => void;
}

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
const buildMetadataWithMemos = (
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

const pad2 = (n: number) => n.toString().padStart(2, '0');

/**
 * Format an ISO timestamp as a compact "YYYY-MM-DD HH:mm" string. Falls back
 * to the raw value when parsing fails so we don't render "Invalid Date" to
 * the user (e.g. for legacy records or malformed metadata).
 */
const formatTimestamp = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

const githubProjectLink = (gitRemoteUrl: string | null | undefined): { label: string; href: string } | null => {
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

const generateMemoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

interface DetailRowProps {
  label: string;
  value: ReactNode;
}

const DetailRow = ({ label, value }: DetailRowProps) => (
  <div className="flex items-start gap-3 py-1.5 text-sm">
    <span className="w-28 flex-shrink-0 text-muted">{label}</span>
    <span className="flex-1 break-all text-ink">
      {typeof value === 'string' ? (value.trim() ? value : '—') : value ?? '—'}
    </span>
  </div>
);

/**
 * Apply an optimistic mutation to a single project's memo list in the shared
 * store so the UI reflects the change immediately.
 *
 * Returns the **single previous project snapshot** so a failure can restore
 * just that row instead of overwriting the entire `projects` array. The wider
 * "snapshot the whole list" pattern used by `hideProject` etc. is racy: if a
 * websocket-driven `fetchProjects` lands between the optimistic update and
 * the rollback, restoring the cached array would also wipe the fresh data.
 * Returning `null` means the project disappeared from the store mid-flight
 * (e.g. it was deleted by another tab), in which case there is nothing to
 * roll back to.
 */
const applyOptimisticMemos = (
  projectId: string,
  mutate: (memos: ProjectMemo[]) => ProjectMemo[],
): Project | null => {
  let previousEntry: Project | null = null;
  useProjectsStore.setState((state) => ({
    projects: state.projects.map((candidate) => {
      if (candidate.id !== projectId) return candidate;
      previousEntry = candidate;
      const currentMemos = readProjectMemos(candidate);
      const nextMemos = mutate(currentMemos);
      return {
        ...candidate,
        metadata: buildMetadataWithMemos(candidate, nextMemos),
      };
    }),
  }));
  return previousEntry;
};

/**
 * Roll back a single project's optimistic update. We do *not* overwrite the
 * whole `projects` array because other entries may have legitimately changed
 * (agent push, refresh, sort) while the PATCH was in flight.
 */
const restoreProjectSnapshot = (snapshot: Project): void => {
  useProjectsStore.setState((state) => ({
    projects: state.projects.map((candidate) =>
      candidate.id === snapshot.id ? snapshot : candidate,
    ),
  }));
};

export function ProjectDetailsDialog({
  open,
  project,
  mergedMembers,
  onClose,
}: ProjectDetailsDialogProps) {
  const updateProject = useProjectsStore((state) => state.updateProject);
  const { pushToast } = useToast();
  const { confirm } = useConfirm();
  const [draft, setDraft] = useState('');
  const [isMutating, setIsMutating] = useState(false);
  // React 18 silently drops setState calls after unmount, but we still want
  // to avoid running through error UX (draft restore, button toggle) when
  // the user has already closed the dialog. The toast itself still fires so
  // failures are visible — see callers below.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const groupSize = mergedMembers && mergedMembers.length > 0 ? mergedMembers.length : 1;
  const isMergedGroup = groupSize > 1;

  const memos = useMemo(() => {
    const list = readProjectMemos(project);
    // Newest first — timeline reads chronologically downward.
    return [...list].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    });
  }, [project]);

  const githubLink = githubProjectLink(project.gitRemoteUrl);

  const draftLength = draft.length;
  const memoCount = memos.length;
  const isOverLengthLimit = draftLength > MAX_MEMO_CONTENT_CHARS;
  const isOverCountLimit = memoCount >= MAX_MEMOS_PER_PROJECT;
  const canSubmitDraft =
    Boolean(draft.trim())
    && !isOverLengthLimit
    && !isOverCountLimit
    && !isMutating;

  /**
   * Resolve the freshest snapshot for this project from the store. The
   * `project` prop comes from a closure that may lag if the store updated
   * between renders (e.g. a websocket push); reading the latest snapshot
   * narrows the "last-write-wins" window for memo mutations.
   */
  const readLatestProject = (): Project => {
    const stored = useProjectsStore
      .getState()
      .projects.find((candidate) => candidate.id === project.id);
    return stored ?? project;
  };

  const handleAddMemo = async () => {
    if (!canSubmitDraft) return;
    const content = draft.trim();

    const newMemo: ProjectMemo = {
      id: generateMemoId(),
      content,
      createdAt: new Date().toISOString(),
    };

    const latestProject = readLatestProject();
    const nextMemos = [newMemo, ...readProjectMemos(latestProject)];
    const nextMetadata = buildMetadataWithMemos(latestProject, nextMemos);

    // Optimistic update so the new memo appears immediately. We capture the
    // pre-mutation snapshot for this *one* project so a failure restores
    // only this row — unrelated `projects[]` updates that may have landed in
    // the meantime are preserved.
    const previousSnapshot = applyOptimisticMemos(project.id, () => nextMemos);
    setIsMutating(true);
    try {
      await updateProject(project.id, { metadata: nextMetadata });
      // Clear the composition only on success so a failed save leaves the
      // user's text in place — no "disappears then reappears" flicker.
      if (isMountedRef.current) {
        setDraft('');
      }
    } catch (error) {
      if (previousSnapshot) {
        restoreProjectSnapshot(previousSnapshot);
      }
      pushToast({
        title: 'Failed to save memo',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'error',
      });
    } finally {
      if (isMountedRef.current) {
        setIsMutating(false);
      }
    }
  };

  const handleDeleteMemo = async (memoId: string) => {
    if (isMutating) return;
    const accepted = await confirm({
      title: 'Delete memo?',
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!accepted) return;

    const latestProject = readLatestProject();
    const nextMemos = readProjectMemos(latestProject).filter((memo) => memo.id !== memoId);
    const nextMetadata = buildMetadataWithMemos(latestProject, nextMemos);

    const previousSnapshot = applyOptimisticMemos(project.id, (current) =>
      current.filter((memo) => memo.id !== memoId),
    );
    setIsMutating(true);
    try {
      await updateProject(project.id, { metadata: nextMetadata });
    } catch (error) {
      if (previousSnapshot) {
        restoreProjectSnapshot(previousSnapshot);
      }
      pushToast({
        title: 'Failed to delete memo',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'error',
      });
    } finally {
      if (isMountedRef.current) {
        setIsMutating(false);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project.name}
      description="Project details"
      maxWidthClassName="max-w-2xl"
    >
      <div className="space-y-6">
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Overview</h3>
          <div className="mt-2 rounded-xl border border-border bg-paper/40 px-4 py-2">
            <DetailRow label="Daemon" value={project.daemonHost ?? null} />
            <DetailRow label="Workspace" value={project.workspacePath ?? null} />
            <DetailRow label="Branch" value={project.worktreeBranch ?? null} />
            <DetailRow label="Last commit" value={formatTimestamp(project.lastCommitAt)} />
            {githubLink ? (
              <DetailRow
                label="GitHub"
                value={(
                  <a
                    href={githubLink.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] underline-offset-2 hover:underline"
                  >
                    {githubLink.label}
                  </a>
                )}
              />
            ) : null}
            <DetailRow label="Created" value={formatTimestamp(project.createdAt)} />
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Memo</h3>
            <span className="text-xs text-muted">
              {memoCount} / {MAX_MEMOS_PER_PROJECT}
            </span>
          </div>

          {isMergedGroup ? (
            // Merged-group memos are written to the primary daemon's project
            // row only — surface that so the user doesn't expect a unified
            // timeline across daemons.
            <p className="mt-2 rounded-lg border border-dashed border-border bg-paper/30 px-3 py-2 text-xs text-muted">
              This project is merged across {groupSize} daemons. Memos shown here are
              stored on <code className="font-mono">{project.daemonHost ?? 'this row'}</code>{' '}
              only.
            </p>
          ) : null}

          <div className="mt-2 space-y-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Ctrl/Cmd + Enter submits — matches the convention used by
                // other authoring surfaces (issues, tasks) in this app.
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void handleAddMemo();
                }
              }}
              placeholder="Write a memo… (Cmd/Ctrl + Enter to save)"
              rows={3}
              className="w-full resize-y rounded-xl border border-border bg-panel px-3 py-2 text-sm text-ink outline-none focus:border-[var(--accent)]"
              disabled={isMutating}
              aria-label="New memo"
            />
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span
                className={isOverLengthLimit ? 'text-[var(--error)]' : undefined}
                aria-live="polite"
              >
                {draftLength} / {MAX_MEMO_CONTENT_CHARS}
                {isOverLengthLimit ? ' — memo too long' : ''}
                {!isOverLengthLimit && isOverCountLimit
                  ? ` — limit reached (${MAX_MEMOS_PER_PROJECT}). Delete an old memo first.`
                  : ''}
              </span>
              <button
                type="button"
                onClick={() => void handleAddMemo()}
                disabled={!canSubmitDraft}
                className="webapp-btn-primary px-4 py-2 text-sm disabled:opacity-60"
              >
                {isMutating ? 'Saving…' : 'Add memo'}
              </button>
            </div>
          </div>

          <div className="mt-4">
            {memoCount === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
                No memos yet. Notes you add above will appear here in timeline order.
              </div>
            ) : (
              <ol className="relative space-y-4 border-l border-border pl-5">
                {memos.map((memo) => (
                  <li key={memo.id} className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -left-[27px] top-1.5 inline-block h-3 w-3 rounded-full border-2 border-panel bg-[var(--accent)]"
                    />
                    <div className="rounded-xl border border-border bg-paper/30 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <time className="text-xs text-muted" dateTime={memo.createdAt}>
                          {formatTimestamp(memo.createdAt) ?? memo.createdAt}
                        </time>
                        <button
                          type="button"
                          onClick={() => void handleDeleteMemo(memo.id)}
                          disabled={isMutating}
                          className="text-xs text-muted transition-colors hover:text-[var(--error)] disabled:opacity-50"
                          aria-label="Delete memo"
                        >
                          Delete
                        </button>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">
                        {memo.content}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
