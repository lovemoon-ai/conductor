# 0019 Desktop Split View for Task List

## Status

Proposed

## Owner

TBD

## Date

2026-03-23

## Summary

Update the web app task list so desktop users can stay on `/app/tasks` and read or continue the selected task conversation in a right-side detail pane. The change only applies to desktop list view. Mobile keeps the current tap-to-navigate behavior, and the existing `/app/tasks/[taskId]` route remains the direct-detail entrypoint.

## Context

- `/app/tasks` currently renders only the task collection.
- `/app/tasks/[taskId]` renders the actual conversation or PTY terminal.
- This creates an extra navigation step on desktop when users are scanning many tasks and quickly switching between sessions.
- The code already has a reusable content boundary at `ChatView` and `TerminalView`, but the surrounding loading, fetch, read-state, and header logic still lives inside the route page.
- The page also supports both `list` and `grid` views. Grid already has richer inline previews and input affordances, so the desktop split-view requirement should stay scoped to list view.

## Goals

- Keep desktop users on `/app/tasks` while switching between tasks in list view.
- Reuse the existing task detail content instead of building a second chat surface.
- Preserve current mobile behavior.
- Preserve direct routing to `/app/tasks/[taskId]`.
- Keep task creation compatible with the new desktop split-view flow.

## Non-Goals

- Do not replace the dedicated `/app/tasks/[taskId]` page.
- Do not redesign the grid view.
- Do not change chat or PTY runtime semantics.
- Do not introduce a second global navigation model for tasks.

## Options Considered

### Option A: Always navigate, but prefetch more aggressively

- Pros:
  - Smallest code change.
  - No new selection state on `/app/tasks`.
- Cons:
  - Does not solve the desktop workflow problem.
  - Still breaks list scanning flow with every click.

### Option B: Desktop split view only for list mode

- Pros:
  - Matches the request directly.
  - Limits layout complexity to the view that actually needs master-detail behavior.
  - Avoids interfering with the current grid-card interaction model.
- Cons:
  - Requires a small amount of responsive selection state.
  - The list route and detail route need to share one task-detail container.

### Option C: Desktop split view for both list and grid

- Pros:
  - More consistent behavior across view modes.
- Cons:
  - Overlaps awkwardly with grid cards that already embed previews and composer actions.
  - Larger UX and testing surface than requested.

## Proposed Design

Choose Option B.

### 1. Reusable task detail pane

Extract the task detail loading and rendering logic from `/app/tasks/[taskId]/page.tsx` into a reusable component.

Responsibilities:

- fetch the selected task detail
- mark the task as read
- render loading and not-found states
- render `ChatView` for AI tasks
- render `TerminalView` for PTY tasks
- optionally render a header, so the same component can be reused both in the route page and the desktop split pane

### 2. Desktop-only selection on `/app/tasks`

On `/app/tasks`:

- if viewport is mobile, keep the current full-width list and route navigation behavior
- if viewport is desktop and the current view mode is `list`, render a two-pane layout
- the left pane keeps the existing list
- the right pane renders the reusable task detail pane for the selected task

Selection rules:

- initial selection prefers `taskId` from search params when it exists in the current list
- otherwise default to the first visible task
- when the selected task disappears because of filter or deletion, fall back to the first visible task
- when there are no tasks, render the current empty-state path and no detail pane

### 3. Click behavior

`TaskItem` will support two open behaviors:

- route navigation, used on mobile and existing detail flows
- inline selection, used on desktop list split view

This keeps one visual task-item component while letting the page decide whether a click means navigation or selection.

### 4. Create-task behavior

When a task is created from `/app/tasks` in desktop list split view:

- do not navigate away to `/app/tasks/[taskId]`
- select the newly created task in-place
- keep current navigation for non-split cases

### 5. Connection status

The embedded detail pane still needs per-task connection status. `ConnectionStatus` currently infers `taskId` from route params, so it will accept an optional explicit task ID override for the split-view case.

## Risks

- Responsive selection state can drift from the filtered task list if fallback rules are incomplete.
- The right pane introduces nested scrolling; the container boundaries must stay `overflow-hidden` at the page level and `overflow-y-auto` at the pane level.
- Create-task behavior can regress if the split-view callback path and existing route-navigation path diverge.

## Rollout

- Add the reusable task detail pane.
- Switch `/app/tasks/[taskId]` to reuse it.
- Add the desktop list split-view to `/app/tasks`.
- Wire create-task selection callback for split view.
- Add or update page and component tests for desktop vs mobile behavior.

## Acceptance

- On mobile, tapping a task from `/app/tasks` still navigates to `/app/tasks/[taskId]`.
- On desktop in list view, clicking a task keeps the user on `/app/tasks` and shows that task in a right-side pane.
- On desktop in grid view, current behavior remains unchanged.
- Creating a task from desktop list split view keeps the user on `/app/tasks` and selects the new task.
- Direct access to `/app/tasks/[taskId]` still works.

## Open Questions

- Whether the `taskId` query param should be treated as a stable, shareable desktop deep link long term, or only as UI persistence for the split view.
- Whether future desktop work should add resize controls for the list/detail pane widths.
