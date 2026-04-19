# Symptom

- The all-project Issues page could list issues from all projects but could not create a new issue.
- Status changes and board position calculation risked using issues from other projects when all-project data was present.

# Root Cause

- `/app/issues` changed to an all-project view, but the create button and create dialog still assumed a resolved project id.
- Status append and drag position calculations used the whole visible issue list rather than the moved issue's project-scoped list.

# Fix

- Kept the create button enabled in all-project mode after project resolution completes.
- Added a project picker to `CreateIssueDialog` when no project id is provided.
- Fetch all issues when no project is selected.
- Calculate status-change and board drag positions from issues with the same `projectId`.
- Added page, dialog, store, API, and board regression tests for all-project behavior.

# How To Avoid Next Time

- When introducing an all-project aggregate view, audit create, update, delete, and reorder paths for project-scope assumptions.
- Keep backend ordering semantics and frontend ordering calculations scoped the same way.
- Add tests for aggregate views that mutate one item while unrelated projects are present.
