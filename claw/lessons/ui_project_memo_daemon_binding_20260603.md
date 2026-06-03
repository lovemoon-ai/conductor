# Project details must separate daemon tabs from merged memo timeline

## Symptom

In a merged project with more than one project daemon, opening the project
settings details panel could expose project details and memo state through the
same daemon row boundary. Users needed details to be inspectable per daemon, but
memo entries to remain visible together in one memo timeline with source context.

## Root Cause

Project memos were implemented in `project.metadata.memos`, while merged
projects are represented as multiple `Project` rows, one per daemon. The
details dialog reused one selected project row for both the details panel and
the memo panel. Memo timeline entries did not carry their source project ID or
daemon label, so the UI could not show a combined timeline while still writing
adds and deletes back to the correct source row.

## Fix

The details dialog now separates those concerns:

- Project details render as daemon tabs for merged groups.
- Memo entries from every merged member render together in one reverse
  chronological timeline.
- Each memo entry carries its source project ID and shows the daemon label next
  to the date.
- Adding a memo writes to the active daemon tab only.
- Deleting a memo writes to that memo entry's source daemon project only.

Regression tests cover merged memo aggregation, daemon tab switching, active-tab
memo creation, and source-only deletion.

## Prevention

When adding fields to project details, explicitly decide whether the field is
per-daemon detail data or group-level timeline data. For merged projects,
timeline entries should carry source identity separately from display grouping,
so the UI can aggregate entries without losing the row that owns each mutation.
