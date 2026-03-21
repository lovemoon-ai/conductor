# ui: PTY runtime details visibility review (2026-03-22)

## Symptoms
- On PTY task detail pages, clicking the connection status control did not open `Runtime Details`.
- After enabling the panel for PTY tasks, the default light popover styling had poor contrast against the dark terminal background.

## Root Cause
- `web/src/app/app/tasks/[taskId]/page.tsx` explicitly disabled `showConnectionStatus` for `pty_task`, which also disabled the `Runtime Details` popover interaction.
- `ConnectionStatus` used a single shared light popover style and did not account for PTY task pages rendering over a dark terminal surface.

## Fix
- Enabled `showConnectionStatus` for PTY task detail pages.
- Updated `ConnectionStatus` to detect the current task type and render a dark translucent frosted panel with white text for PTY tasks only.
- Added regression tests for PTY task header behavior and PTY-specific runtime details styling.

## Prevention
- Avoid tying visibility of diagnostic UI to task type unless the interaction is truly unsupported.
- When a shared component is reused across very different surfaces, validate its contrast and overlay behavior in each host context.
- Add a regression test whenever task-type conditionals affect whether a user can open or inspect runtime state.
