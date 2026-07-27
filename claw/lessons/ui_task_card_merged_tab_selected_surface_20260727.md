# Merged task-card selection colored every tab title

## Symptom

When a merged task card was not selected, every tab title correctly matched the
task card background. After selecting/opening the visible task, however, the
selected task-card color was applied to every tab title instead of only the tab
that owned the visible task.

## Root cause

`TaskList` published one `--task-card-surface` custom property on the merged-card
wrapper. That value included the visible card's active and multi-select state,
and every tab consumed the same property. The implementation correctly kept the
active tab/card seam aligned, but it accidentally made inactive tabs inherit the
selected surface as well.

The missing distinction was between:

- the visible card's current surface; and
- the same card's resting, unselected surface.

## Fix

`TaskList` now publishes both surface colors:

- `--task-card-surface` for the visible card's current state; and
- `--task-card-resting-surface` for an unselected card in the same layout mode.

Only the active tab consumes the current card surface. Inactive tabs consume the
resting surface. When no task is selected, the two values resolve to the same
color, preserving the previous seamless appearance. The calculation continues
to use `taskCardSurfaceColor()`, so normal list mode, desktop list-pane mode, and
multi-select mode stay aligned with `TaskItem`.

## How to avoid next time

- Treat a merged card's body, active tab, and inactive tabs as separate visual
  states even when they share a common surface while idle.
- When sharing CSS custom properties between a container and its children,
  check whether stateful children really should inherit the same value.
- Add state-transition coverage for both sides of a visual rule: idle equality
  and selected differentiation.

## Tests

`web/src/features/tasks/components/TaskList.test.tsx` verifies that:

- an unselected merged card publishes the same current and resting surfaces;
- selecting the visible task changes only the active tab's surface source; and
- desktop list-pane mode preserves the same active-tab-only behavior.

Full verification:

```text
cd web && pnpm test --run
180 test files passed; 1525 tests passed.
```
