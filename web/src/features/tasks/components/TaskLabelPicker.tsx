'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TASK_LABEL_CHIP_CLASSNAME,
  type TaskLabel,
} from '@/lib/projects/task-labels';
import { toggleTaskLabelId } from '@/lib/tasks/task-labels';

interface TaskLabelPickerProps {
  /** Every label defined on the task's display project and its merged siblings. */
  projectLabels: TaskLabel[];
  /** Ids currently attached to the task — may include ids this view doesn't define. */
  selectedIds: string[];
  /** Called with the full next id set — the picker never sends a delta. */
  onChange: (nextIds: string[]) => void;
  disabled?: boolean;
}

/** `max-h-64` plus the gap — enough to decide whether the menu fits below. */
const MENU_MAX_HEIGHT_PX = 260;

type MenuPosition =
  | { left: number; top: number }
  | { left: number; bottom: number };

/**
 * The "+" affordance in a task card's chip row: a popover listing the project's
 * labels as toggles.
 *
 * The menu is portalled into `document.body` with fixed positioning. It cannot
 * render inline: the chip row is `overflow-x-auto` (which forces `overflow-y`
 * to compute to `auto`) and the card wrapper is `overflow-hidden`, so an
 * absolutely positioned child is clipped to nothing. `MoveToProjectMenu` in
 * TaskItem escapes the same clip box the same way.
 */
export function TaskLabelPicker({
  projectLabels,
  selectedIds,
  onChange,
  disabled = false,
}: TaskLabelPickerProps) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isOpen = position !== null;

  useEffect(() => {
    if (!isOpen) return;
    const close = () => setPosition(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    // A fixed-position menu would drift away from its card when the list
    // scrolls, so close instead — but not for scrolling the menu's own list.
    const handleScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node | null)) return;
      close();
    };
    // Deferred so the opening click can't immediately dismiss the menu. Clicks
    // inside the menu and on the trigger stop propagation before reaching here.
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', close);
      document.addEventListener('keydown', handleKeyDown);
      window.addEventListener('scroll', handleScroll, true);
      window.addEventListener('resize', close);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [isOpen]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    // Flip above the trigger near the bottom of the viewport, when there is
    // more room there.
    setPosition(
      spaceBelow < MENU_MAX_HEIGHT_PX && rect.top > spaceBelow
        ? { left: rect.left, bottom: window.innerHeight - rect.top + 4 }
        : { left: rect.left, top: rect.bottom + 4 },
    );
  };

  const menu = isOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label="Task labels"
        style={{ position: 'fixed', zIndex: 9999, ...position }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="max-h-64 w-48 overflow-y-auto rounded-lg border border-border bg-[var(--paper)] p-1 shadow-lg"
      >
        {projectLabels.map((label) => {
          const checked = selectedIds.includes(label.id);
          return (
            <button
              key={label.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={checked}
              onClick={() => onChange(toggleTaskLabelId(selectedIds, label.id, projectLabels))}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-border/40"
            >
              <span
                aria-hidden="true"
                className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                  checked
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                    : 'border-border'
                }`}
              >
                {checked ? '✓' : ''}
              </span>
              <span className={`min-w-0 truncate ${TASK_LABEL_CHIP_CLASSNAME}`}>
                {label.name}
              </span>
            </button>
          );
        })}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Edit task labels"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        title="Edit labels"
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isOpen) setPosition(null);
          else openMenu();
        }}
        className="flex shrink-0 items-center rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
      >
        +
      </button>
      {menu}
    </>
  );
}
