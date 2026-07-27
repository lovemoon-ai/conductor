# Symptom

When attaching a PTY terminal to an AI task and switching the detail pane to
the terminal for the first time:

- The top-left refresh button (yellow dot) was disabled/grayed out.
- The terminal did not show a blinking input cursor and could not be typed
  into.
- Only after navigating to another task and back did the refresh button become
  enabled; and only after then manually clicking refresh did the cursor appear
  and interaction start working.

This happened every time (deterministic), not intermittently.

# Root Cause

Two independent defects stacked together.

1. **Stale `init` status on the locally-hydrated PTY task.**
   - A freshly created PTY task is persisted with `status: "init"`
     (`web/src/app/api/tasks/[taskId]/terminal/route.ts` → `createAttachedTerminalRecord`).
   - `TaskDetailPane` hydrates the attached PTY task into **component-local
     state** via a one-shot `api.get('/tasks/{ptyTaskId}')`, and this row is
     intentionally kept OUT of the shared task store
     (`useTasksStore` drops `pty_task` upserts). So the local snapshot never
     receives the later `task_status_update` that flips the PTY to `running`.
   - `TerminalView` gates everything on
     `shouldAutoAttach = task.status === 'running' || 'unknown'`. With a frozen
     `init`, `canRefreshTerminal` was `false` (refresh disabled) and the
     auto-attach effect early-returned, so `terminal_attach` was never sent and
     the session stayed `idle`.
   - Navigating away/back changed `taskId`, forcing a re-fetch that happened to
     read the now-`running` row — which is why the workaround "worked".

2. **Initial focus fired too early.**
   - The only initial `terminal.focus()` ran synchronously inside the async
     setup effect, right after `terminal.open()`, while `connectionState` was
     still `connecting` and the detail pane could still be mid panel-switch
     transition (element not visible → `.focus()` is a browser no-op). There
     was no re-focus when the session transitioned to `open`, so the cursor
     never appeared until the user clicked refresh (which calls `focus()`
     again).

# Fix

- `TaskDetailPane`: mirror the owning AI task's server-denormalized
  `attachedTerminal.ptyTaskStatus` (which IS refreshed on the PTY's realtime
  `task_status_update`) into the local PTY snapshot, so `init → running`
  propagates in place without needing a navigation round-trip.
- `TerminalView`: added an effect that re-runs `syncSize()` + `terminal.focus()`
  via `requestAnimationFrame` when `isTerminalReady && connectionState === 'open'`,
  so the cursor shows automatically once the session opens and layout has
  settled.
- Added regression tests (both verified to fail when the corresponding fix is
  reverted):
  - `TaskDetailPane.test.tsx` — mirrors `attachedTerminal.ptyTaskStatus`
    `init → running` into the hydrated PTY snapshot without re-navigation.
  - `TerminalView.test.tsx` — re-focuses the terminal on the transition to
    `connectionState === 'open'`.

# How To Avoid Next Time

- When a piece of realtime-mutable state is hydrated into component-local state
  (deliberately bypassing the shared store), add an explicit path to keep it
  fresh — either subscribe to updates or derive from a store field that IS
  updated. A one-shot fetch of a row that changes status is a latent staleness
  bug.
- Treat `init` as a first-class transient status in any UI gate; don't assume a
  just-created resource is already `running`.
- Focus/measure calls that depend on visibility/layout should run after the
  relevant state transition (and a frame), not synchronously during mount while
  a container may still be hidden or animating.
