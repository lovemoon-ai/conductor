'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import type { Issue } from '@/shared/types';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_BADGE_CLASSNAMES,
  ISSUE_STATUS_LABELS,
} from '@/lib/issues/config';

const stopEventPropagation = (event: SyntheticEvent) => {
  event.stopPropagation();
};

const pickIssueAiToolBadge = (issue: Issue): string | null => {
  // Mirror IssueDetailsDialog's resolution order so the card and the dialog
  // agree: requested backend (metadata) → live task → archived breadcrumb.
  const metaBackend = issue.metadata && typeof issue.metadata.backendType === 'string'
    ? issue.metadata.backendType.trim()
    : '';
  if (metaBackend) {
    return metaBackend;
  }
  const liveTaskBackend = issue.activeTask?.backendType
    ?? issue.linkedTask?.backendType
    ?? (Array.isArray(issue.tasks) && issue.tasks.length > 0 ? issue.tasks[0].backendType : null);
  if (liveTaskBackend && liveTaskBackend.trim()) {
    return liveTaskBackend.trim();
  }
  const persisted = typeof issue.aiBackendType === 'string' ? issue.aiBackendType.trim() : '';
  return persisted || null;
};

function IssueStatusMenu({
  issue,
  onStatusChange,
  disabled,
}: {
  issue: Issue;
  onStatusChange?: ((issueId: string, status: Issue['status']) => Promise<void> | void) | undefined;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const handleSelect = async (nextStatus: Issue['status']) => {
    setOpen(false);
    if (!onStatusChange || disabled || isUpdating || nextStatus === issue.status) {
      return;
    }
    setIsUpdating(true);
    try {
      await onStatusChange(issue.id, nextStatus);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div
      ref={menuRef}
      className="relative shrink-0"
      onPointerDown={stopEventPropagation}
      onClick={stopEventPropagation}
      onDoubleClick={stopEventPropagation}
    >
      <button
        type="button"
        aria-label={`Change status for ${issue.title}`}
        disabled={disabled || isUpdating}
        onClick={() => setOpen((current) => !current)}
        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${ISSUE_STATUS_BADGE_CLASSNAMES[issue.status]} ${
          disabled || isUpdating ? 'opacity-70' : 'hover:brightness-95'
        }`}
      >
        {ISSUE_STATUS_LABELS[issue.status]}
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+0.5rem)] z-20 min-w-36 rounded-2xl border border-border/80 bg-panel/70 p-1.5 shadow-[0_18px_48px_rgba(15,23,42,0.14)] backdrop-blur-md">
          {ISSUE_STATUSES.map((status) => {
            const active = status === issue.status;
            return (
              <button
                key={status}
                type="button"
                aria-label={`Move ${issue.title} to ${ISSUE_STATUS_LABELS[status]}`}
                disabled={isUpdating}
                onClick={() => void handleSelect(status)}
                className={`flex w-full items-center rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  active ? 'bg-border/40 text-ink' : 'text-muted hover:bg-border/30 hover:text-ink'
                }`}
              >
                <span>{ISSUE_STATUS_LABELS[status]}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function IssueCardBody({
  issue,
  elevated = false,
  interactive = true,
  disabled = false,
  statusMenuDisabled = false,
  statusAttributes,
  onStatusChange,
  onDelete,
  onOpenDetails,
}: {
  issue: Issue;
  elevated?: boolean;
  interactive?: boolean;
  disabled?: boolean;
  statusMenuDisabled?: boolean;
  statusAttributes?: Record<string, unknown>;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  onDelete?: (issueId: string) => Promise<void> | void;
  onOpenDetails?: (issue: Issue) => void;
}) {
  const description = issue.description?.trim();
  const activeTask = issue.activeTask ?? null;
  const linkedTask = issue.linkedTask ?? activeTask;
  const openTask = activeTask ?? linkedTask;
  const hasHistoricalLinkedTask = !activeTask && Boolean(linkedTask);
  const aiToolBadge = pickIssueAiToolBadge(issue);
  const persistedSessionId = typeof issue.aiSessionId === 'string' ? issue.aiSessionId.trim() : '';
  // Show the archived flag only when the breadcrumb is the only surviving
  // pointer — i.e., no live tasks but the issue still remembers an AI session.
  const isArchivedBreadcrumb = !openTask
    && (!Array.isArray(issue.tasks) || issue.tasks.length === 0)
    && (Boolean(aiToolBadge) || Boolean(persistedSessionId));
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isConfirmingDelete || isDeleting) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!deleteActionRef.current?.contains(event.target as Node)) {
        setIsConfirmingDelete(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isConfirmingDelete, isDeleting]);

  const handleRequestDelete = (event: SyntheticEvent) => {
    stopEventPropagation(event);
    setIsConfirmingDelete(true);
  };

  const handleConfirmDelete = async (event: SyntheticEvent) => {
    stopEventPropagation(event);
    if (!onDelete || isDeleting) {
      return;
    }
    setIsDeleting(true);
    try {
      await onDelete(issue.id);
      setIsConfirmingDelete(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDoubleClick = useCallback((event: SyntheticEvent) => {
    if (!interactive || !onOpenDetails) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    onOpenDetails(issue);
  }, [interactive, issue, onOpenDetails]);

  return (
    <article
      className={[
        'rounded-2xl border border-border bg-panel/90 p-4 shadow-sm transition-shadow',
        elevated ? 'shadow-lg ring-1 ring-accent/20' : 'hover:shadow-md',
        interactive && !disabled ? 'cursor-grab active:cursor-grabbing' : '',
      ].join(' ')}
      data-issue-id={issue.id}
      onDoubleClick={interactive ? handleDoubleClick : undefined}
      {...statusAttributes}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-start gap-2">
          <h3
            className={[
              'min-w-0 flex-1 text-sm font-semibold text-ink',
              interactive ? 'select-none' : '',
            ].join(' ')}
          >
            {issue.title}
          </h3>
          {interactive ? (
            <IssueStatusMenu issue={issue} onStatusChange={onStatusChange} disabled={statusMenuDisabled} />
          ) : (
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${ISSUE_STATUS_BADGE_CLASSNAMES[issue.status]}`}>
              {ISSUE_STATUS_LABELS[issue.status]}
            </span>
          )}
        </div>

        {description ? (
          <p
            className="mt-2 whitespace-pre-wrap break-words text-sm text-muted/90 line-clamp-3"
            title={description}
          >
            {description}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted/60">No description</p>
        )}

        {aiToolBadge || persistedSessionId ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {aiToolBadge ? (
              <span
                className="inline-flex items-center rounded-full border border-border/70 bg-paper/50 px-2 py-0.5 text-[11px] font-medium text-muted"
                title={isArchivedBreadcrumb ? `AI tool used by the (now-deleted) task: ${aiToolBadge}` : `AI tool: ${aiToolBadge}`}
              >
                {aiToolBadge}
              </span>
            ) : null}
            {persistedSessionId ? (
              <code
                className="max-w-[14rem] truncate rounded-md border border-border/70 bg-paper/60 px-1.5 py-0.5 text-[11px] font-mono text-muted"
                title={`Session id: ${persistedSessionId}`}
              >
                {persistedSessionId}
              </code>
            ) : null}
            {isArchivedBreadcrumb ? (
              <span
                className="text-[10px] uppercase tracking-wide text-muted/70"
                title="The originating task is no longer available; this is the persisted breadcrumb on the issue."
              >
                archived
              </span>
            ) : null}
          </div>
        ) : null}

        {interactive && (openTask || onDelete) ? (
          <div
            className="mt-3 flex items-center gap-2"
            onPointerDown={stopEventPropagation}
            onClick={stopEventPropagation}
            onDoubleClick={stopEventPropagation}
          >
            {openTask ? (
              <Link
                href={`/app/tasks/${encodeURIComponent(openTask.id)}`}
                onPointerDown={stopEventPropagation}
                onClick={stopEventPropagation}
                onDoubleClick={stopEventPropagation}
                className="inline-flex rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-border/40"
              >
                {hasHistoricalLinkedTask ? 'Open last task' : 'Open task'}
              </Link>
            ) : null}

            {onDelete ? (
              <button
                ref={deleteActionRef}
                type="button"
                aria-label={isConfirmingDelete ? `Confirm deleting ${issue.title}` : `Delete issue ${issue.title}`}
                disabled={isDeleting}
                onClick={(event) => {
                  if (isConfirmingDelete) {
                    void handleConfirmDelete(event);
                    return;
                  }
                  handleRequestDelete(event);
                }}
                className={[
                  'rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60',
                  isConfirmingDelete
                    ? 'bg-[var(--error)] text-white hover:opacity-90'
                    : 'border border-[var(--error)]/30 text-[var(--error)] hover:bg-[var(--error)]/10',
                ].join(' ')}
              >
                {isDeleting ? 'Deleting...' : (isConfirmingDelete ? 'Delete?' : 'Delete')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function IssueCard({
  issue,
  disabled = false,
  statusMenuDisabled = false,
  onStatusChange,
  onDelete,
  onOpenDetails,
}: {
  issue: Issue;
  disabled?: boolean;
  statusMenuDisabled?: boolean;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  onDelete?: (issueId: string) => Promise<void> | void;
  onOpenDetails?: (issue: Issue) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: issue.id,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
    touchAction: disabled ? 'auto' : 'none',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <IssueCardBody
        issue={issue}
        disabled={disabled}
        statusMenuDisabled={statusMenuDisabled}
        onStatusChange={onStatusChange}
        onDelete={onDelete}
        onOpenDetails={onOpenDetails}
        statusAttributes={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

export function IssueCardOverlay({ issue }: { issue: Issue }) {
  return <IssueCardBody issue={issue} elevated interactive={false} />;
}
