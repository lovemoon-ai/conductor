# Desktop task split pane selection sync bug

## Symptom
- In desktop `tasks` list split-pane mode, clicking a different task could fail to switch the right-side detail pane.
- PTY tasks made the issue especially obvious because the terminal pane appeared to stay blank or stuck on the previous task.

## Root cause
- The page kept both a local `selectedTaskId` state and a URL-driven `taskId` search param.
- A sync change made the incoming `taskId` query param take precedence too aggressively.
- During an inline click, the old URL param could briefly remain stale and overwrite the freshly selected task before the URL update completed.

## Fix
- Treat URL `taskId` as authoritative only when it actually changes from the outside.
- Preserve local inline selection during user clicks until the page updates the URL to match.
- Add page-level regression tests for:
  - clicking a new task while an old `taskId` is already in the URL
  - external search-param changes
  - creating the first task from an empty desktop list view

## How to avoid next time
- When state is mirrored in both component state and URL params, define which transitions are external and which are local before changing effect priority.
- Add regression tests for both directions of sync:
  - UI -> URL
  - URL -> UI
- For split-pane selection flows, always test with an already-populated `taskId` in the URL.
