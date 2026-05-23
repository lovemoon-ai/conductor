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

export type IssueOwnerOption = {
  userId: string;
  label: string;
  projectId?: string;
  projectName?: string;
};

const getOwnerInitials = (label: string): string => {
  const normalized = label.trim();
  if (!normalized) {
    return '?';
  }
  if (!normalized.includes('@')) {
    const digits = normalized.replace(/\D/g, '');
    if (digits.length >= 2) {
      return digits.slice(-2);
    }
    if (digits.length === 1) {
      return digits;
    }
  }
  const compact = normalized.includes('@') ? normalized.split('@')[0] : normalized;
  return compact.slice(0, 2).toUpperCase();
};

function IssueOwnerBadge({
  issue,
  ownerOptions = [],
}: {
  issue: Issue;
  ownerOptions?: IssueOwnerOption[];
}) {
  const owner = ownerOptions.find((option) => option.userId === issue.ownerUserId) ?? null;
  const ownerLabel = owner?.label ?? issue.owner?.label ?? issue.ownerUserId ?? 'Unassigned';

  return (
    <span
      aria-label={`Issue owner ${ownerLabel}`}
      title={ownerLabel}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-paper text-[10px] font-semibold text-ink"
      onPointerDown={stopEventPropagation}
      onClick={stopEventPropagation}
      onDoubleClick={stopEventPropagation}
    >
      {getOwnerInitials(ownerLabel)}
    </span>
  );
}

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

/**
 * Pull the daemon this issue has actually been committed to (i.e. some task
 * has run or is running for it). Returns null when the issue is still floating
 * in todo with no daemon binding — that's the "could run on any daemon" state
 * we deliberately do NOT advertise on the card.
 *
 * Resolution priority:
 *   1. `activeTask.agentHost`        — currently running, freshest signal
 *   2. `linkedTask.agentHost`        — historical last run
 *   3. `metadata.daemonHost`         — written by the MoveIssueToDoing dialog
 *      when no task has actually started yet (rare; covers in-flight cases)
 *
 * `issue.daemonHost` (the API-populated project daemon) is intentionally NOT
 * included as a fallback — that field reflects the project's currently-bound
 * daemon, which is exactly what we want to hide pre-commitment in merged or
 * multi-daemon-default contexts.
 */
const pickCommittedDaemon = (issue: Issue): string | null => {
  const activeHost = typeof issue.activeTask?.agentHost === 'string'
    ? issue.activeTask.agentHost.trim()
    : '';
  if (activeHost) return activeHost;
  const linkedHost = typeof issue.linkedTask?.agentHost === 'string'
    ? issue.linkedTask.agentHost.trim()
    : '';
  if (linkedHost) return linkedHost;
  const metadataHost = typeof issue.metadata?.daemonHost === 'string'
    ? issue.metadata.daemonHost.trim()
    : '';
  if (metadataHost) return metadataHost;
  return null;
};

function IssueCardBody({
  issue,
  elevated = false,
  interactive = true,
  disabled = false,
  statusMenuDisabled = false,
  statusAttributes,
  onStatusChange,
  ownerOptions,
  onDelete,
  onOpenDetails,
  multiDaemonContext = false,
}: {
  issue: Issue;
  elevated?: boolean;
  interactive?: boolean;
  disabled?: boolean;
  statusMenuDisabled?: boolean;
  statusAttributes?: Record<string, unknown>;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  ownerOptions?: IssueOwnerOption[];
  onDelete?: (issueId: string) => Promise<void> | void;
  onOpenDetails?: (issue: Issue) => void;
  /**
   * True only when the issue's project is in a multi-daemon scenario — either
   * part of a cross-daemon merged group, OR a default project with 2+ online
   * non-fire daemons. Single-daemon projects pass false so the daemon chip
   * stays hidden (the daemon is implicit there). The parent owns this
   * computation because it requires both the projects list and the live
   * agents list.
   */
  multiDaemonContext?: boolean;
}) {
  const description = issue.description?.trim();
  const activeTask = issue.activeTask ?? null;
  const linkedTask = issue.linkedTask ?? activeTask;
  const openTask = activeTask ?? linkedTask;
  const hasHistoricalLinkedTask = !activeTask && Boolean(linkedTask);
  const showOwnerBadge = (ownerOptions?.length ?? 0) > 1;
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
          {showOwnerBadge ? <IssueOwnerBadge issue={issue} ownerOptions={ownerOptions} /> : null}
          {interactive ? (
            <IssueStatusMenu issue={issue} onStatusChange={onStatusChange} disabled={statusMenuDisabled} />
          ) : (
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${ISSUE_STATUS_BADGE_CLASSNAMES[issue.status]}`}>
              {ISSUE_STATUS_LABELS[issue.status]}
            </span>
          )}
        </div>

        {(() => {
          // Three-stage gate per product spec:
          //   - multiDaemonContext: the parent decided the project is in a
          //     merged group OR is a default project with 2+ online daemons.
          //     Anything else (single-daemon bound project) suppresses the
          //     chip entirely — the daemon is implicit there.
          //   - status must be past `todo`. A todo issue is still floating
          //     "could run on any daemon", so even if metadata.daemonHost
          //     lingers from a previous doing→todo bounce, the card stays
          //     honest by hiding the chip.
          //   - committedDaemon: the issue has actually been bound to a
          //     specific daemon via task spawn / metadata. Belt-and-braces
          //     in case the status check passes but no signal exists yet.
          if (!multiDaemonContext) return null;
          if (issue.status === 'todo') return null;
          const committedDaemon = pickCommittedDaemon(issue);
          if (!committedDaemon) return null;
          return (
            <div className="mt-2 flex items-center gap-1.5">
              <span
                title={
                  issue.projectName
                    ? `${issue.projectName} on ${committedDaemon}`
                    : committedDaemon
                }
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${pickDaemonBadgeClass(committedDaemon)}`}
              >
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                {committedDaemon}
              </span>
            </div>
          );
        })()}

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
  ownerOptions,
  onDelete,
  onOpenDetails,
  multiDaemonContext = false,
}: {
  issue: Issue;
  disabled?: boolean;
  statusMenuDisabled?: boolean;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  ownerOptions?: IssueOwnerOption[];
  onDelete?: (issueId: string) => Promise<void> | void;
  onOpenDetails?: (issue: Issue) => void;
  multiDaemonContext?: boolean;
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
        ownerOptions={ownerOptions}
        onDelete={onDelete}
        onOpenDetails={onOpenDetails}
        statusAttributes={{ ...attributes, ...listeners }}
        multiDaemonContext={multiDaemonContext}
      />
    </div>
  );
}

export function IssueCardOverlay({
  issue,
  ownerOptions,
  multiDaemonContext = false,
}: {
  issue: Issue;
  ownerOptions?: IssueOwnerOption[];
  multiDaemonContext?: boolean;
}) {
  return (
    <IssueCardBody
      issue={issue}
      ownerOptions={ownerOptions}
      elevated
      interactive={false}
      multiDaemonContext={multiDaemonContext}
    />
  );
}
