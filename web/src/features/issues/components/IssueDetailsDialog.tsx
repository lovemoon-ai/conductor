'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { Issue, Task } from '@/shared/types';
import { Dialog } from '@/components/common/Dialog';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useToast } from '@/components/common/FeedbackProvider';
import { DEFAULT_ISSUE_PRIORITY, ISSUE_PRIORITIES, ISSUE_PRIORITY_LABELS } from '@/lib/issues/config';
import { useIssuesStore } from '../store';
import type { IssueOwnerOption } from './IssueCard';

const pickIssueBackendType = (issue: Issue | null): string | null => {
  if (!issue) {
    return null;
  }
  const metaBackend = issue.metadata && typeof issue.metadata.backendType === 'string'
    ? issue.metadata.backendType.trim()
    : '';
  if (metaBackend) {
    return metaBackend;
  }
  const latestTaskBackend = issue.activeTask?.backendType
    ?? issue.linkedTask?.backendType
    ?? (Array.isArray(issue.tasks) && issue.tasks.length > 0 ? issue.tasks[0].backendType : null);
  if (latestTaskBackend && latestTaskBackend.trim()) {
    return latestTaskBackend.trim();
  }
  // Fall through to the breadcrumb persisted on the issue row itself so the
  // AI tool stays visible after the originating task is deleted/unlinked.
  const persistedBackend = typeof issue.aiBackendType === 'string'
    ? issue.aiBackendType.trim()
    : '';
  return persistedBackend || null;
};

const collectIssueTasks = (issue: Issue | null): Task[] => {
  if (!issue) {
    return [];
  }
  const list: Task[] = [];
  const seen = new Set<string>();
  const push = (task: Task | null | undefined) => {
    if (!task || !task.id || seen.has(task.id)) {
      return;
    }
    seen.add(task.id);
    list.push(task);
  };
  // Tasks are already sorted newest-first by the API.
  if (Array.isArray(issue.tasks)) {
    for (const task of issue.tasks) {
      push(task);
    }
  }
  push(issue.activeTask ?? null);
  push(issue.linkedTask ?? null);
  return list;
};

const formatShortId = (id: string | null | undefined): string => {
  if (!id) {
    return '—';
  }
  const trimmed = id.trim();
  if (trimmed.length <= 10) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
};

export function IssueDetailsDialog({
  open,
  onClose,
  issue,
  ownerOptions = [],
}: {
  open: boolean;
  onClose: () => void;
  issue: Issue | null;
  ownerOptions?: IssueOwnerOption[];
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Issue['priority']>(DEFAULT_ISSUE_PRIORITY);
  const [ownerUserId, setOwnerUserId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const updateIssue = useIssuesStore((state) => state.updateIssue);
  const { pushToast } = useToast();

  useEffect(() => {
    if (!open || !issue) {
      return;
    }
    setTitle(issue.title);
    setDescription(issue.description ?? '');
    setPriority(issue.priority);
    setOwnerUserId(issue.ownerUserId ?? issue.owner?.id ?? '');
    setLocalError(null);
  }, [issue, open]);

  useEffect(() => {
    if (!open || !issue || ownerOptions.length === 0) {
      return;
    }
    setOwnerUserId((current) => (
      current && ownerOptions.some((option) => option.userId === current)
        ? current
        : issue.ownerUserId ?? issue.owner?.id ?? ownerOptions[0]?.userId ?? ''
    ));
  }, [issue, open, ownerOptions]);

  const backendType = useMemo(() => pickIssueBackendType(issue), [issue]);
  const tasks = useMemo(() => collectIssueTasks(issue), [issue]);
  const sessionEntries = useMemo(
    () => {
      const entries: Array<{ key: string; sessionId: string; orphan: boolean }> = [];
      const seen = new Set<string>();
      for (const task of tasks) {
        const sessionId = task.sessionId?.trim();
        if (!sessionId || seen.has(sessionId)) {
          continue;
        }
        seen.add(sessionId);
        entries.push({ key: `${task.id}-${sessionId}`, sessionId, orphan: false });
      }
      // Fall through to the breadcrumb persisted on the issue row when the
      // originating task is gone — that's the whole point of mirroring the
      // session id onto the issue.
      const persistedSessionId = typeof issue?.aiSessionId === 'string'
        ? issue.aiSessionId.trim()
        : '';
      if (persistedSessionId && !seen.has(persistedSessionId)) {
        entries.push({
          key: `issue-${issue?.id ?? 'unknown'}-${persistedSessionId}`,
          sessionId: persistedSessionId,
          orphan: true,
        });
      }
      return entries;
    },
    [issue, tasks],
  );
  // Last entry (oldest) is the historical one; first (newest) is the latest
  // task-id which is navigable.
  const latestTaskId = tasks[0]?.id ?? null;

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!issue) {
      return;
    }
    const nextTitle = title.trim();
    if (!nextTitle) {
      setLocalError('Title is required.');
      return;
    }

    const nextDescription = description.trim();
    const previousDescription = issue.description?.trim() ?? '';
    const titleChanged = nextTitle !== issue.title;
    const descriptionChanged = nextDescription !== previousDescription;
    const priorityChanged = priority !== issue.priority;
    const currentOwnerUserId = issue.ownerUserId ?? issue.owner?.id ?? '';
    const ownerChanged = Boolean(ownerUserId) && ownerUserId !== currentOwnerUserId;

    if (!titleChanged && !descriptionChanged && !priorityChanged && !ownerChanged) {
      onClose();
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    try {
      await updateIssue(issue.id, {
        ...(titleChanged ? { title: nextTitle } : {}),
        ...(descriptionChanged ? { description: nextDescription ? nextDescription : null } : {}),
        ...(priorityChanged ? { priority } : {}),
        ...(ownerChanged ? { ownerUserId } : {}),
      });
      pushToast({
        title: 'Issue updated',
        variant: 'success',
      });
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to update issue.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Issue Details"
      maxWidthClassName="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="mb-2 block text-sm font-medium text-ink">Title</label>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Summarize the issue"
            className="w-full webapp-input"
            autoFocus
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-ink">Description</label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Add context, acceptance criteria, or raw requirement notes"
            className="min-h-32 w-full resize-y webapp-input"
          />
        </div>

        <div>
          <label htmlFor="issue-details-priority" className="mb-2 block text-sm font-medium text-ink">Priority</label>
          <select
            id="issue-details-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value as Issue['priority'])}
            className="w-full webapp-input"
          >
            {ISSUE_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {ISSUE_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        {ownerOptions.length > 1 ? (
          <div>
            <label htmlFor="issue-details-owner" className="mb-2 block text-sm font-medium text-ink">
              Owner
            </label>
            <select
              id="issue-details-owner"
              value={ownerUserId}
              onChange={(event) => setOwnerUserId(event.target.value)}
              className="w-full webapp-input"
            >
              {ownerOptions.map((option) => (
                <option key={option.userId} value={option.userId}>
                  {option.projectName ? `${option.label} · ${option.projectName}` : option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="space-y-3 rounded-2xl border border-border/70 bg-panel/40 p-4">
          <h3 className="text-sm font-semibold text-ink">Runtime</h3>

          <div className="grid grid-cols-[minmax(7rem,max-content)_1fr] items-start gap-x-3 gap-y-2 text-sm">
            <span className="text-muted">AI tool</span>
            <span className="text-ink">
              {backendType ? (
                <span className="inline-flex items-center rounded-full border border-border/70 bg-paper/50 px-2.5 py-0.5 text-xs font-medium">
                  {backendType}
                </span>
              ) : (
                <span className="text-muted/70">Not selected</span>
              )}
            </span>

            <span className="text-muted">Session IDs</span>
            <span className="text-ink">
              {sessionEntries.length > 0 ? (
                <ul className="space-y-1">
                  {sessionEntries.map((entry) => (
                    <li key={entry.key} className="flex items-center gap-2">
                      <code
                        className="max-w-full truncate rounded-md border border-border/70 bg-paper/60 px-2 py-0.5 text-xs font-mono"
                        title={entry.sessionId}
                      >
                        {entry.sessionId}
                      </code>
                      {entry.orphan ? (
                        <span
                          className="text-[11px] uppercase tracking-wide text-muted/70"
                          title="Persisted on this issue; the originating task is no longer available"
                        >
                          archived
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted/70">None</span>
              )}
            </span>

            <span className="text-muted">Task IDs</span>
            <span className="text-ink">
              {tasks.length > 0 ? (
                <ul className="space-y-1">
                  {tasks.map((task, index) => {
                    const clickable = task.id === latestTaskId && index === 0;
                    const idLabel = formatShortId(task.id);
                    return (
                      <li key={task.id} className="flex items-center gap-2">
                        {clickable ? (
                          <Link
                            href={`/app/tasks/${encodeURIComponent(task.id)}`}
                            className="rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-mono text-accent hover:bg-accent/20"
                            title={`Open task ${task.id}`}
                          >
                            {idLabel}
                          </Link>
                        ) : (
                          <code
                            className="rounded-md border border-border/70 bg-paper/60 px-2 py-0.5 text-xs font-mono text-muted"
                            title={task.id}
                          >
                            {idLabel}
                          </code>
                        )}
                        {index === 0 ? (
                          <span className="text-[11px] uppercase tracking-wide text-muted/70">latest</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <span className="text-muted/70">No tasks yet</span>
              )}
            </span>
          </div>
        </div>

        {localError ? (
          <InlineNotice variant="error" title="Update failed">
            {localError}
          </InlineNotice>
        ) : null}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg px-4 py-2.5 text-sm text-muted transition-colors hover:bg-border/30 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!issue || !title.trim() || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
