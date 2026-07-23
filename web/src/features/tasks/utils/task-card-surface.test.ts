import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SURFACE_COLOR_BY_CLASS,
  TASK_CARD_BASE_SURFACE_COLOR,
  taskCardSurfaceClassName,
  taskCardSurfaceColor,
} from './task-card-surface';

describe('taskCardSurfaceClassName', () => {
  it('uses the plain card surface when nothing is selected or open', () => {
    expect(taskCardSurfaceClassName({})).toBe('');
  });

  it('marks a checked card with the strong highlight', () => {
    expect(taskCardSurfaceClassName({ selectionMode: true, isSelected: true })).toBe(
      'webapp-card-active-strong',
    );
  });

  it('highlights the opened card only outside selection mode', () => {
    expect(taskCardSurfaceClassName({ isActive: true })).toBe('webapp-card-active');
    expect(taskCardSurfaceClassName({ isActive: true, selectionMode: true })).toBe('');
  });

  it('switches to pane surfaces in desktop list-pane mode', () => {
    expect(taskCardSurfaceClassName({ desktopListPaneMode: true, isActive: true })).toBe(
      'webapp-card-list-pane-active',
    );
    expect(taskCardSurfaceClassName({ desktopListPaneMode: true })).toBe(
      'webapp-card-list-pane-idle',
    );
  });

  it('falls back to the selection surfaces while selecting in pane mode', () => {
    expect(
      taskCardSurfaceClassName({
        desktopListPaneMode: true,
        selectionMode: true,
        isSelected: true,
      }),
    ).toBe('webapp-card-active-strong');
  });
});

describe('taskCardSurfaceColor', () => {
  // Merged-card tabs sit flush on the card's top edge, so they must paint the
  // exact same color the card does or the seam shows as a band.
  it('resolves the light-white panel surface for a selected card', () => {
    expect(taskCardSurfaceColor({ desktopListPaneMode: true, isActive: true })).toBe(
      'var(--surface-panel)',
    );
  });

  it('resolves the unselected card surface in pane mode', () => {
    expect(taskCardSurfaceColor({ desktopListPaneMode: true })).toBe('var(--surface-default)');
  });

  it('resolves the highlight mixes outside pane mode', () => {
    expect(taskCardSurfaceColor({ isSelected: true })).toBe('var(--surface-task-active-strong)');
    expect(taskCardSurfaceColor({ isActive: true })).toBe('var(--surface-task-active)');
  });

  it('falls back to the base card background', () => {
    expect(taskCardSurfaceColor({})).toBe(TASK_CARD_BASE_SURFACE_COLOR);
    expect(TASK_CARD_BASE_SURFACE_COLOR).toBe('var(--surface-panel)');
  });

  it('agrees with the class name for every state combination', () => {
    const bools = [false, true];
    for (const desktopListPaneMode of bools) {
      for (const selectionMode of bools) {
        for (const isSelected of bools) {
          for (const isActive of bools) {
            const state = { desktopListPaneMode, selectionMode, isSelected, isActive };
            const className = taskCardSurfaceClassName(state);
            const expected =
              className === '' ? TASK_CARD_BASE_SURFACE_COLOR : SURFACE_COLOR_BY_CLASS[className];
            expect(expected).toBeDefined();
            expect(taskCardSurfaceColor(state)).toBe(expected);
          }
        }
      }
    }
  });
});

/**
 * The color map is a hand-maintained mirror of `globals.css`. Without this
 * test, editing a `.webapp-card*` background there leaves the map stale and
 * silently reintroduces the tab/card seam with every other test still green.
 */
describe('SURFACE_COLOR_BY_CLASS vs globals.css', () => {
  const css = readFileSync(
    join(__dirname, '..', '..', '..', 'app', 'globals.css'),
    'utf8',
  );

  /** Background declared by the rule whose selector list contains `selector`. */
  function backgroundFor(selector: string): string | undefined {
    for (const block of css.split('}')) {
      const [selectorText, body] = block.split('{');
      if (!body) continue;
      const selectors = selectorText.split(',').map((s) => s.trim());
      if (!selectors.includes(selector)) continue;
      const match = body.match(/(?:^|;)\s*background\s*:\s*([^;]+)/);
      if (match) return match[1].trim();
    }
    return undefined;
  }

  it('matches the base .webapp-card background', () => {
    expect(backgroundFor('.webapp-card')).toBe(TASK_CARD_BASE_SURFACE_COLOR);
  });

  it('matches every modifier class background', () => {
    const entries = Object.entries(SURFACE_COLOR_BY_CLASS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [className, color] of entries) {
      expect(backgroundFor(`.webapp-card.${className}`), className).toBe(color);
    }
  });
});
