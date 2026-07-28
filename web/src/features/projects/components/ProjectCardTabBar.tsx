'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

export interface ProjectCardTab {
  /** Representative project id identifying the tab within its aggregation. */
  projectId: string;
  /** The card's project name, used as the default tab label. */
  name: string;
  /** Custom label override, if the user renamed the tab. */
  label: string | null;
}

interface ProjectCardTabBarProps {
  tabs: ProjectCardTab[];
  activeProjectId: string;
  onSelect: (projectId: string) => void;
  onEject: (projectId: string) => void;
  onRename: (projectId: string, label: string) => void;
}

const TAB_LONG_PRESS_MS = 450;
const TAB_LONG_PRESS_MOVE_TOLERANCE_SQ = 100;

/**
 * The tab strip shown on an aggregated project card. Clicking a tab brings its
 * card to the front; double-clicking ejects it from the aggregation; a
 * press-and-hold renames it inline. Pointer events stop propagation so they
 * never start a card drag; project selection is handled explicitly by onSelect.
 */
export function ProjectCardTabBar({
  tabs,
  activeProjectId,
  onSelect,
  onEject,
  onRename,
}: ProjectCardTabBarProps) {
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const longPressStartRef = useRef({ x: 0, y: 0 });

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const beginEdit = useCallback((tab: ProjectCardTab) => {
    setEditingProjectId(tab.projectId);
    setEditingValue(tab.label ?? tab.name);
  }, []);

  const commitEdit = useCallback(() => {
    if (editingProjectId) {
      onRename(editingProjectId, editingValue);
    }
    setEditingProjectId(null);
    setEditingValue('');
  }, [editingProjectId, editingValue, onRename]);

  const cancelEdit = useCallback(() => {
    setEditingProjectId(null);
    setEditingValue('');
  }, []);

  const handleTabPointerDown = useCallback((tab: ProjectCardTab, event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (editingProjectId) return;
    clearLongPress();
    longPressFiredRef.current = false;
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressFiredRef.current = true;
      beginEdit(tab);
    }, TAB_LONG_PRESS_MS);
  }, [beginEdit, clearLongPress, editingProjectId]);

  const handleTabPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!longPressTimerRef.current) return;
    const dx = event.clientX - longPressStartRef.current.x;
    const dy = event.clientY - longPressStartRef.current.y;
    if (dx * dx + dy * dy > TAB_LONG_PRESS_MOVE_TOLERANCE_SQ) {
      clearLongPress();
    }
  }, [clearLongPress]);

  const handleTabPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    clearLongPress();
  }, [clearLongPress]);

  const handleTabClick = useCallback((tab: ProjectCardTab, event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
    // A completed long-press already opened the rename editor; don't also select.
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    if (editingProjectId) return;
    onSelect(tab.projectId);
  }, [editingProjectId, onSelect]);

  const handleTabDoubleClick = useCallback((tab: ProjectCardTab, event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
    clearLongPress();
    onEject(tab.projectId);
  }, [clearLongPress, onEject]);

  return (
    <div
      role="tablist"
      aria-label="Aggregated projects"
      className="mb-2 flex flex-wrap items-center gap-1"
      // Keep tab interactions off the card's drag handle / selection.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {tabs.map((tab) => {
        const isActive = tab.projectId === activeProjectId;
        const displayLabel = tab.label ?? tab.name;
        if (editingProjectId === tab.projectId) {
          return (
            <input
              key={tab.projectId}
              autoFocus
              type="text"
              aria-label="Rename tab"
              value={editingValue}
              onChange={(event) => setEditingValue(event.target.value)}
              onBlur={commitEdit}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitEdit();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEdit();
                }
              }}
              className="min-w-0 max-w-[10rem] rounded-md border-0 bg-transparent px-2 py-0.5 text-xs font-medium text-ink outline-none ring-1 ring-[var(--accent)]"
            />
          );
        }
        return (
          <button
            key={tab.projectId}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={`${displayLabel} — double-click to remove, hold to rename`}
            onPointerDown={(event) => handleTabPointerDown(tab, event)}
            onPointerMove={handleTabPointerMove}
            onPointerUp={handleTabPointerUp}
            onPointerCancel={handleTabPointerUp}
            onClick={(event) => handleTabClick(tab, event)}
            onDoubleClick={(event) => handleTabDoubleClick(tab, event)}
            className={`max-w-[10rem] truncate rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
              isActive
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'bg-[var(--paper)] text-muted hover:text-ink'
            }`}
          >
            {displayLabel}
          </button>
        );
      })}
    </div>
  );
}
