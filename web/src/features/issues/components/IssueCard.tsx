'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import type { Issue } from '@/shared/types';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_BADGE_CLASSNAMES,
  ISSUE_STATUS_LABELS,
} from '@/lib/issues/config';
import { EditIssueDialog } from './EditIssueDialog';

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD_SQ = 25;

const stopEventPropagation = (event: SyntheticEvent) => {
  event.stopPropagation();
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
    <div ref={menuRef} className="relative shrink-0" onPointerDown={stopEventPropagation} onClick={stopEventPropagation}>
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
}: {
  issue: Issue;
  elevated?: boolean;
  interactive?: boolean;
  disabled?: boolean;
  statusMenuDisabled?: boolean;
  statusAttributes?: Record<string, unknown>;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  onDelete?: (issueId: string) => Promise<void> | void;
}) {
  const description = issue.description?.trim();
  const activeTask = issue.activeTask ?? null;
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const deleteActionRef = useRef<HTMLButtonElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartXRef = useRef(0);
  const longPressStartYRef = useRef(0);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const handleTitlePointerDown = useCallback((event: ReactPointerEvent<HTMLHeadingElement>) => {
    if (!interactive) {
      return;
    }
    clearLongPress();
    longPressStartXRef.current = event.clientX;
    longPressStartYRef.current = event.clientY;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      setIsEditDialogOpen(true);
    }, LONG_PRESS_MS);
  }, [clearLongPress, interactive]);

  const handleTitlePointerMove = useCallback((event: ReactPointerEvent<HTMLHeadingElement>) => {
    if (!longPressTimerRef.current) {
      return;
    }
    const dx = event.clientX - longPressStartXRef.current;
    const dy = event.clientY - longPressStartYRef.current;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_THRESHOLD_SQ) {
      clearLongPress();
    }
  }, [clearLongPress]);

  const handleTitlePointerEnd = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

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

  return (
    <article
      className={[
        'rounded-2xl border border-border bg-panel/90 p-4 shadow-sm transition-shadow',
        elevated ? 'shadow-lg ring-1 ring-accent/20' : 'hover:shadow-md',
        interactive && !disabled ? 'cursor-grab active:cursor-grabbing' : '',
      ].join(' ')}
      data-issue-id={issue.id}
      {...statusAttributes}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-start gap-2">
          <h3
            className={[
              'min-w-0 flex-1 text-sm font-semibold text-ink',
              interactive ? 'select-none' : '',
            ].join(' ')}
            onPointerDown={interactive ? handleTitlePointerDown : undefined}
            onPointerMove={interactive ? handleTitlePointerMove : undefined}
            onPointerUp={interactive ? handleTitlePointerEnd : undefined}
            onPointerCancel={interactive ? handleTitlePointerEnd : undefined}
            onPointerLeave={interactive ? handleTitlePointerEnd : undefined}
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
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted/90">
            {description}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted/60">No description</p>
        )}

        {interactive && (activeTask || onDelete) ? (
          <div className="mt-3 flex items-center gap-2" onPointerDown={stopEventPropagation} onClick={stopEventPropagation}>
            {activeTask ? (
              <Link
                href={`/app/tasks/${encodeURIComponent(activeTask.id)}`}
                onPointerDown={stopEventPropagation}
                onClick={stopEventPropagation}
                className="inline-flex rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-border/40"
              >
                Open task
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
      {interactive ? (
        <EditIssueDialog
          open={isEditDialogOpen}
          onClose={() => setIsEditDialogOpen(false)}
          issue={issue}
        />
      ) : null}
    </article>
  );
}

export function IssueCard({
  issue,
  disabled = false,
  statusMenuDisabled = false,
  onStatusChange,
  onDelete,
}: {
  issue: Issue;
  disabled?: boolean;
  statusMenuDisabled?: boolean;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  onDelete?: (issueId: string) => Promise<void> | void;
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
        statusAttributes={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

export function IssueCardOverlay({ issue }: { issue: Issue }) {
  return <IssueCardBody issue={issue} elevated interactive={false} />;
}
