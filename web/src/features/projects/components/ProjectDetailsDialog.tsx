'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import type { Project } from '@/shared/types';
import {
  buildMetadataWithMemos,
  formatTimestamp,
  generateMemoId,
  githubProjectLink,
  MAX_MEMO_CONTENT_CHARS,
  MAX_MEMOS_PER_PROJECT,
  type ProjectMemo,
  readProjectMemos,
} from './ProjectDetailsDialog.utils';
import { useProjectsStore } from '../store';

interface ProjectDetailsDialogProps {
  open: boolean;
  project: Project;
  /**
   * All members of the merged project group this dialog represents. Details are
   * shown per daemon, while memos stay on their source daemon project and render
   * together in one timeline.
   */
  mergedMembers?: Project[];
  onClose: () => void;
}

interface DetailRowProps {
  label: string;
  value: ReactNode;
}

interface MemoTimelineEntry {
  projectId: string;
  daemonLabel: string;
  memo: ProjectMemo;
}

const DetailRow = ({ label, value }: DetailRowProps) => (
  <div className="flex items-start gap-3 py-1.5 text-sm">
    <span className="w-28 flex-shrink-0 text-muted">{label}</span>
    <span className="flex-1 break-all text-ink">
      {typeof value === 'string' ? (value.trim() ? value : '—') : value ?? '—'}
    </span>
  </div>
);

const collectProjectMembers = (project: Project, mergedMembers?: Project[]): Project[] => {
  const members: Project[] = [];
  const seen = new Set<string>();
  const pushUnique = (candidate: Project) => {
    if (seen.has(candidate.id)) return;
    seen.add(candidate.id);
    members.push(candidate);
  };

  pushUnique(project);
  for (const member of mergedMembers ?? []) {
    pushUnique(member);
  }
  return members;
};

const getDaemonLabel = (project: Project): string => {
  const daemonHost = typeof project.daemonHost === 'string' ? project.daemonHost.trim() : '';
  if (daemonHost) return daemonHost;

  const workspacePath = typeof project.workspacePath === 'string' ? project.workspacePath.trim() : '';
  if (workspacePath) return workspacePath;

  return project.name || project.id;
};

/**
 * Apply an optimistic mutation to project memo rows in the shared store so the
 * UI reflects the change immediately.
 *
 * Returns the previous snapshots for only the affected rows so a failure can
 * restore them without overwriting unrelated websocket-driven project changes.
 */
const applyOptimisticMemos = (
  projectIds: string[],
  mutate: (memos: ProjectMemo[]) => ProjectMemo[],
): Project[] => {
  const targetIds = new Set(projectIds);
  const previousEntries: Project[] = [];
  useProjectsStore.setState((state) => ({
    projects: state.projects.map((candidate) => {
      if (!targetIds.has(candidate.id)) return candidate;
      previousEntries.push(candidate);
      const currentMemos = readProjectMemos(candidate);
      const nextMemos = mutate(currentMemos);
      return {
        ...candidate,
        metadata: buildMetadataWithMemos(candidate, nextMemos),
      };
    }),
  }));
  return previousEntries;
};

/**
 * Roll back optimistic memo updates. We do *not* overwrite the whole
 * `projects` array because other entries may have legitimately changed
 * (agent push, refresh, sort) while the PATCH was in flight.
 */
const restoreProjectSnapshots = (snapshots: Project[]): void => {
  if (snapshots.length === 0) return;
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  useProjectsStore.setState((state) => ({
    projects: state.projects.map((candidate) =>
      snapshotsById.get(candidate.id) ?? candidate,
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
  const [activeProjectId, setActiveProjectId] = useState(project.id);
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

  const detailProjects = useMemo(
    () => collectProjectMembers(project, mergedMembers),
    [mergedMembers, project],
  );
  const isMergedGroup = detailProjects.length > 1;
  const activeProject = useMemo(
    () =>
      detailProjects.find((member) => member.id === activeProjectId)
      ?? detailProjects[0]
      ?? project,
    [activeProjectId, detailProjects, project],
  );

  useEffect(() => {
    setActiveProjectId(project.id);
  }, [project.id]);

  useEffect(() => {
    if (detailProjects.some((member) => member.id === activeProjectId)) return;
    setActiveProjectId(detailProjects[0]?.id ?? project.id);
  }, [activeProjectId, detailProjects, project.id]);

  const memoEntries = useMemo<MemoTimelineEntry[]>(() => {
    const entries = detailProjects.flatMap((member) =>
      readProjectMemos(member).map((memo) => ({
        projectId: member.id,
        daemonLabel: getDaemonLabel(member),
        memo,
      })),
    );
    // Newest first — timeline reads chronologically downward.
    return entries.toSorted((a, b) => {
      const aTime = new Date(a.memo.createdAt).getTime();
      const bTime = new Date(b.memo.createdAt).getTime();
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    });
  }, [detailProjects]);

  const githubLink = githubProjectLink(activeProject.gitRemoteUrl);

  const draftLength = draft.length;
  const memoCount = memoEntries.length;
  const activeProjectMemoCount = readProjectMemos(activeProject).length;
  const activeDaemonLabel = getDaemonLabel(activeProject);
  const isOverLengthLimit = draftLength > MAX_MEMO_CONTENT_CHARS;
  const isOverCountLimit = activeProjectMemoCount >= MAX_MEMOS_PER_PROJECT;
  const canSubmitDraft =
    Boolean(draft.trim())
    && !isOverLengthLimit
    && !isOverCountLimit
    && !isMutating;

  /**
   * Resolve the freshest snapshot for a memo source project from the store. The
   * `project` prop comes from a closure that may lag if the store updated
   * between renders (e.g. a websocket push); reading the latest snapshot
   * narrows the "last-write-wins" window for memo mutations.
   */
  const readLatestProject = (target: Project): Project => {
    const stored = useProjectsStore
      .getState()
      .projects.find((candidate) => candidate.id === target.id);
    return stored ?? target;
  };

  const updateMemoTarget = async (target: Project, nextMemos: ProjectMemo[]) => {
    const latestTarget = readLatestProject(target);
    await updateProject(latestTarget.id, {
      metadata: buildMetadataWithMemos(latestTarget, nextMemos),
    });
  };

  const handleAddMemo = async () => {
    if (!canSubmitDraft) return;
    const content = draft.trim();

    const newMemo: ProjectMemo = {
      id: generateMemoId(),
      content,
      createdAt: new Date().toISOString(),
    };

    const latestProject = readLatestProject(activeProject);
    const nextMemos = [newMemo, ...readProjectMemos(latestProject)];

    const previousSnapshots = applyOptimisticMemos([activeProject.id], () => nextMemos);
    setIsMutating(true);
    try {
      await updateMemoTarget(activeProject, nextMemos);
      // Clear the composition only on success so a failed save leaves the
      // user's text in place — no "disappears then reappears" flicker.
      if (isMountedRef.current) {
        setDraft('');
      }
    } catch (error) {
      restoreProjectSnapshots(previousSnapshots);
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

  const handleDeleteMemo = async (sourceProjectId: string, memoId: string) => {
    if (isMutating) return;
    const accepted = await confirm({
      title: 'Delete memo?',
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!accepted) return;

    const sourceProject =
      detailProjects.find((member) => member.id === sourceProjectId)
      ?? activeProject;
    const latestProject = readLatestProject(sourceProject);
    const nextMemos = readProjectMemos(latestProject).filter((memo) => memo.id !== memoId);

    const previousSnapshots = applyOptimisticMemos([sourceProject.id], () => nextMemos);
    setIsMutating(true);
    try {
      await updateMemoTarget(sourceProject, nextMemos);
    } catch (error) {
      restoreProjectSnapshots(previousSnapshots);
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
          {isMergedGroup ? (
            <div className="mt-2 flex flex-wrap gap-2" role="tablist" aria-label="Daemon details">
              {detailProjects.map((member) => {
                const selected = member.id === activeProject.id;
                return (
                  <button
                    key={member.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setActiveProjectId(member.id)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? 'border-[var(--accent)] bg-paper text-[var(--accent)]'
                        : 'border-border bg-panel text-muted hover:text-ink'
                    }`}
                  >
                    {getDaemonLabel(member)}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div
            role={isMergedGroup ? 'tabpanel' : undefined}
            className={`${isMergedGroup ? 'mt-3' : 'mt-2'} rounded-xl border border-border bg-paper/40 px-4 py-2`}
          >
            <DetailRow label="Daemon" value={activeProject.daemonHost ?? null} />
            <DetailRow label="Workspace" value={activeProject.workspacePath ?? null} />
            <DetailRow label="Branch" value={activeProject.worktreeBranch ?? null} />
            <DetailRow label="Last commit" value={formatTimestamp(activeProject.lastCommitAt)} />
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
            <DetailRow label="Created" value={formatTimestamp(activeProject.createdAt)} />
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Memo</h3>
            <span className="text-xs text-muted">
              {isMergedGroup
                ? `${memoCount} total, ${activeProjectMemoCount} / ${MAX_MEMOS_PER_PROJECT} on ${activeDaemonLabel}`
                : `${memoCount} / ${MAX_MEMOS_PER_PROJECT}`}
            </span>
          </div>

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
                  ? ` — limit reached for ${activeDaemonLabel} (${MAX_MEMOS_PER_PROJECT}). Delete an old memo first.`
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
                {memoEntries.map(({ projectId, daemonLabel, memo }) => (
                  <li key={`${projectId}:${memo.id}`} className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -left-[27px] top-1.5 inline-block size-3 rounded-full border-2 border-panel bg-[var(--accent)]"
                    />
                    <div className="rounded-xl border border-border bg-paper/30 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <time className="text-xs text-muted" dateTime={memo.createdAt}>
                            {formatTimestamp(memo.createdAt) ?? memo.createdAt}
                          </time>
                          {isMergedGroup ? (
                            <span className="text-[11px] font-medium text-muted">
                              {daemonLabel}
                            </span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleDeleteMemo(projectId, memo.id)}
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
