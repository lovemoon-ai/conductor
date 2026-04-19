# Symptom

- On mobile Issue board, multiple status filters could be selected at the same time.
- Users wanted mobile to show exactly one Issue status at a time.

# Root Cause

- `IssueList` modeled visible statuses as an array and toggled each status independently.
- The mobile UI reused board-like multi-section visibility instead of a single active status tab model.

# Fix

- Replaced the visible status array with one `visibleStatus` value.
- Default to the first non-empty status, or Backlog when no status has issues.
- Updated empty-state copy and tests to reflect a single selected status.

# How To Avoid Next Time

- Model mobile tab/filter UIs with a single selected key unless the product explicitly needs multi-select.
- Add tests for both the default selected status and switching behavior on constrained mobile surfaces.
