/**
 * Single source of truth for a task card's background surface.
 *
 * The merged-card tabs sit flush on the card's top edge, so the tab strip has
 * to paint the exact same background as the card underneath it — otherwise the
 * seam between tab and card shows as a color band. Both `TaskItem` (which
 * applies the class) and `TaskList` (which paints the tabs) derive their
 * surface from here so the two can never drift.
 *
 * The class names below mirror the `.webapp-card*` rules in `globals.css`.
 */

export interface TaskCardSurfaceState {
  /** Desktop master/detail pane rendering (list pane next to a detail pane). */
  desktopListPaneMode?: boolean;
  /** Multi-select mode is on (at least one card is checked). */
  selectionMode?: boolean;
  /** This card is checked in multi-select mode. */
  isSelected?: boolean;
  /** This card is the currently opened task. */
  isActive?: boolean;
}

/**
 * Exported so a test can diff it against the real `.webapp-card*` rules in
 * `globals.css` — otherwise this map silently goes stale when the CSS changes
 * and the tab/card seam this module exists to prevent comes right back.
 */
export const SURFACE_COLOR_BY_CLASS: Record<string, string> = {
  'webapp-card-active': 'var(--surface-task-active)',
  'webapp-card-active-strong': 'var(--surface-task-active-strong)',
  'webapp-card-list-pane-idle': 'var(--surface-default)',
  'webapp-card-list-pane-active': 'var(--surface-panel)',
};

/** Base `.webapp-card` background, used when no modifier class applies. */
export const TASK_CARD_BASE_SURFACE_COLOR = 'var(--surface-panel)';

/**
 * The surface modifier class to add alongside `webapp-card`, or `''` when the
 * card keeps the plain `.webapp-card` background.
 */
export function taskCardSurfaceClassName(state: TaskCardSurfaceState): string {
  const {
    desktopListPaneMode = false,
    selectionMode = false,
    isSelected = false,
    isActive = false,
  } = state;

  if (desktopListPaneMode && !selectionMode) {
    return isActive ? 'webapp-card-list-pane-active' : 'webapp-card-list-pane-idle';
  }
  if (isSelected) return 'webapp-card-active-strong';
  // While selecting, the opened-task highlight is suppressed so the checked
  // state stays the only signal in play.
  if (isActive && !selectionMode) return 'webapp-card-active';
  return '';
}

/** The CSS color expression the card actually paints for a given state. */
export function taskCardSurfaceColor(state: TaskCardSurfaceState): string {
  const className = taskCardSurfaceClassName(state);
  return SURFACE_COLOR_BY_CLASS[className] ?? TASK_CARD_BASE_SURFACE_COLOR;
}
