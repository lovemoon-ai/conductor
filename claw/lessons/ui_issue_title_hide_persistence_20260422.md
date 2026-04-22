# Symptom

- Double-clicking the `Issues` page title could hide completed issues for the current view.
- That hide state was not persisted, so navigating away and coming back showed done issues again.

# Root Cause

- The `Issues` page kept the double-click hide behavior in page-local React state only.
- Unlike hidden project visibility, the page did not read from or write to durable browser storage.
- The first implementation pass also reused filtered visible issues when computing a move to `done`, which could ignore already-hidden done issues and produce the wrong append position.

# Fix

- Persisted the `hide done issues` preference in `localStorage` and restored it on mount.
- Threaded the resulting visible status set into both desktop `IssueBoard` and mobile `IssueList` so the UI stays consistent after reloads.
- Changed issue status-change position calculation to use the full project issue list instead of the filtered visible subset.
- Added regression tests for persisted hide state, hidden-done completion ordering, and `IssueList` status reset when available statuses shrink.

# How To Avoid Next Time

- Any title gesture that changes list visibility should be treated as a user preference and implemented with the same persistence pattern as similar pages.
- When adding filtered views, keep write-path calculations based on the full canonical dataset unless the product explicitly wants filtered ordering semantics.
- Add a regression test for the action performed while the filtered items are hidden, not just for the filtered render itself.
