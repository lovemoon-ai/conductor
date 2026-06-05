'use client';

/**
 * The compact PTY indicator that sits next to TaskStatusBadge on each AI
 * task card that has an attached terminal.
 *
 * Interaction model (per product spec):
 *   - Single click  → toggle which panel the right-side detail pane shows
 *                     (chat ↔ attached terminal). Colour reflects which
 *                     panel is currently active: green = terminal, gray =
 *                     chat.
 *   - Double click  → enter a confirm-delete state in place. The button
 *                     swaps its label to "del?" and auto-restores after
 *                     CONFIRM_DELETE_TIMEOUT_MS if the user does nothing.
 *   - Click on "del?" → DELETE the attached terminal.
 *
 * Single-vs-double-click discrimination uses a short DOUBLE_CLICK_WINDOW_MS
 * debounce. The handler also suppresses the trailing click that follows the
 * second native click event in a double-click (so a fast triple-click
 * doesn't fire both the toggle and the delete-confirm).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { getApiClient } from '@/shared/api/client';
import { useToast } from '@/components/common/FeedbackProvider';
import { useTasksStore } from '../store';
import { usePtyToggleStore } from '../pty-toggle-store';

const DOUBLE_CLICK_WINDOW_MS = 250;
const CONFIRM_DELETE_TIMEOUT_MS = 4000;
const POST_DBLCLICK_SUPPRESS_MS = 350;

interface PtyToggleButtonProps {
  aiTaskId: string;
  /** State of the attached PTY task ("running" | "killed" | "init" | ...). */
  attachedPtyTaskStatus: string | null;
}

export function PtyToggleButton({
  aiTaskId,
  attachedPtyTaskStatus,
}: PtyToggleButtonProps) {
  const isActive = usePtyToggleStore((s) => Boolean(s.byAiTaskId[aiTaskId]));
  const toggle = usePtyToggleStore((s) => s.toggle);
  const clearActive = usePtyToggleStore((s) => s.clear);

  const fetchTasks = useTasksStore((s) => s.fetchTasks);
  const showToast = useToast();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Timestamp of the most recent dblclick. We suppress any single-click event
  // that lands within POST_DBLCLICK_SUPPRESS_MS so a triple-click doesn't both
  // open "del?" AND fire an unrelated toggle.
  const lastDblClickAtRef = useRef<number>(0);

  const clearSingleClickTimer = useCallback(() => {
    if (singleClickTimerRef.current !== null) {
      clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
    }
  }, []);

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearSingleClickTimer();
      clearConfirmTimer();
    };
  }, [clearSingleClickTimer, clearConfirmTimer]);

  // Auto-clear "del?" when the attached PTY task ceases to exist (deleted
  // elsewhere or status disappears). Without this, a leftover armed chip
  // would fire a DELETE against a row that's already gone, surfacing a
  // confusing 404 toast.
  useEffect(() => {
    if (!confirmDelete) return;
    if (attachedPtyTaskStatus == null) {
      setConfirmDelete(false);
      clearConfirmTimer();
    }
  }, [attachedPtyTaskStatus, confirmDelete, clearConfirmTimer]);

  // Outside-click cancels the armed state. Without this, a stray click
  // elsewhere on the page leaves the chip red and the user's next click on
  // it surprises them with a delete.
  useEffect(() => {
    if (!confirmDelete) return;
    const handler = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      setConfirmDelete(false);
      clearConfirmTimer();
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [confirmDelete, clearConfirmTimer]);

  const enterConfirmDelete = useCallback(() => {
    setConfirmDelete(true);
    clearConfirmTimer();
    confirmTimerRef.current = setTimeout(() => {
      setConfirmDelete(false);
      confirmTimerRef.current = null;
    }, CONFIRM_DELETE_TIMEOUT_MS);
  }, [clearConfirmTimer]);

  const performDelete = useCallback(async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const api = getApiClient();
      await api.delete(`/tasks/${aiTaskId}/terminal`);
      clearActive(aiTaskId);
      setConfirmDelete(false);
      await fetchTasks(undefined, { recoverStale: false }).catch(() => {});
    } catch (error) {
      showToast({
        title: 'Failed to delete terminal',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'error',
      });
    } finally {
      setIsDeleting(false);
    }
  }, [aiTaskId, clearActive, fetchTasks, isDeleting, showToast]);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDeleting) return;

      // Suppress the trailing single-click that follows the second native
      // click in a double-click sequence. Without this, triple-click would
      // both toggle the panel and arm "del?".
      if (Date.now() - lastDblClickAtRef.current < POST_DBLCLICK_SUPPRESS_MS) {
        return;
      }

      // "del?" → second click confirms deletion.
      if (confirmDelete) {
        clearConfirmTimer();
        void performDelete();
        return;
      }

      // Coalesce a possible double click.
      clearSingleClickTimer();
      singleClickTimerRef.current = setTimeout(() => {
        toggle(aiTaskId);
        singleClickTimerRef.current = null;
      }, DOUBLE_CLICK_WINDOW_MS);
    },
    [
      aiTaskId,
      clearConfirmTimer,
      clearSingleClickTimer,
      confirmDelete,
      isDeleting,
      performDelete,
      toggle,
    ],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDeleting) return;
      clearSingleClickTimer();
      lastDblClickAtRef.current = Date.now();
      enterConfirmDelete();
    },
    [clearSingleClickTimer, enterConfirmDelete, isDeleting],
  );

  const ptyAlive = attachedPtyTaskStatus !== 'killed' && attachedPtyTaskStatus !== 'completed';
  const label = isDeleting ? '...' : confirmDelete ? 'del?' : 'pty';
  const title = isDeleting
    ? 'Deleting terminal…'
    : confirmDelete
      ? 'Click again to delete this terminal'
      : isActive
        ? 'PTY visible — click to show chat; double-click to delete'
        : 'Chat visible — click to show PTY; double-click to delete';

  // Match TaskStatusBadge sizing exactly — same rounded-lg, px-2.5 py-1,
  // text-xs font-medium, no border. Active state uses the same green tones
  // as `running`; inactive uses the same slate tones as `killed`; the
  // confirm-delete state uses the danger red tone.
  const toneClassName = confirmDelete
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    : isActive
      ? ptyAlive
        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
  const baseClassName = 'inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium transition-colors hover:brightness-95';
  // Mirror the running badge's pulsing dot. The dot inherits text color via
  // bg-current, so changing the tone above changes the dot color too —
  // matches how TaskStatusBadge handles it (line 134).
  const shouldPulse = isActive && ptyAlive && !confirmDelete && !isDeleting;

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={title}
      // aria-pressed should reflect "PTY view is active" only — while the
      // chip is in confirm-delete state, the visual is a red "del?"
      // affordance, not a pressed toggle, so screen readers shouldn't
      // announce "pressed".
      aria-pressed={isActive && !confirmDelete}
      aria-busy={isDeleting || undefined}
      title={title}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      data-pty-toggle="true"
      data-pty-active={isActive ? 'true' : 'false'}
      data-pty-confirm-delete={confirmDelete ? 'true' : 'false'}
      data-pty-deleting={isDeleting ? 'true' : 'false'}
      className={`${baseClassName} ${toneClassName} ${isDeleting ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
    >
      {shouldPulse ? (
        <span className="mr-1.5 size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
      ) : null}
      {label}
    </button>
  );
}
