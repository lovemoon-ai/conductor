# Task graph view state persistence bug

## Symptom
- In task graph view, dragged node positions and manually created node connections were lost after opening a task chat and returning to the task list.
- Graph view stayed selected in the URL, but the canvas appeared reset because the graph component remounted with fresh in-memory state.
- When graph view had no visible tasks, the page rendered the old fixed-height list empty/loading state instead of the full-height graph canvas.

## Root cause
- `TaskGraphView` stored `viewport`, `nodePositions`, and `manualEdges` only in component state.
- Opening a node navigates to `/app/tasks/[taskId]`, unmounting the graph. Returning to `/app/tasks?...&view=graph` mounted a new graph with no prior layout state.
- `TaskList` returned early for loading and empty states before it reached the graph-specific full-height layout branch.

## Fix
- Persist graph canvas state in `localStorage` under a project-scope key and hydrate it when the same graph scope mounts again.
- Keep saved positions and manual edges even when filters temporarily hide one of the connected tasks; only visible nodes and edges are rendered.
- Route graph loading, empty, and populated states through the same full-height canvas shell.
- Add regression tests for:
  - restoring dragged positions and manual edges after unmount/remount
  - preserving saved manual edges across temporary task filtering
  - keeping graph loading and empty states full-height

## How to avoid next time
- For editable UI state that should survive route navigation, do not leave it only in component memory. Pick an explicit persistence scope before wiring the interaction.
- When adding a new view mode, audit early returns as well as the main render branch; loading and empty states often bypass the new layout.
- Regression tests should cover route-like unmount/remount behavior, not only interaction inside a single mounted component.
