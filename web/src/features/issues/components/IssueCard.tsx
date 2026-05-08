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

/**
 * Hash a daemon host into one of a small palette so a given daemon stays the
 * same color across cards in a session. Pure function, no React state.
 */
const DAEMON_BADGE_PALETTE = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30',
];
export const pickDaemonBadgeClass = (daemonHost: string): string => {
  let hash = 0;
  for (let i = 0; i < daemonHost.length; i += 1) {
    hash = (hash * 31 + daemonHost.charCodeAt(i)) | 0;
  }
  return DAEMON_BADGE_PALETTE[Math.abs(hash) % DAEMON_BADGE_PALETTE.length];
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

        {issue.daemonHost ? (
          // Daemon attribution chip — surfaced when the parent view is showing
          // issues from multiple daemons (merged cross-daemon project group).
          // Single-daemon views leave `daemonHost` unset so this stays hidden.
          <div className="mt-2 flex items-center gap-1.5">
            <span
              title={
                issue.projectName
                  ? `${issue.projectName} on ${issue.daemonHost}`
                  : issue.daemonHost
              }
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${pickDaemonBadgeClass(issue.daemonHost)}`}
            >
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-80" />
              {issue.daemonHost}
            </span>
          </div>
        ) : null}

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
