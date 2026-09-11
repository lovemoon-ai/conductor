# ui: Views ignored where a task was filed

## Symptom

After filing a task under another project with "move to project" (display-only
`Task.secondProjectId`), the task list showed it under the new project, but
several other views still treated it as part of its real project:

- Project cards counted it in the home project's "N running" / "N stopped"
  chips, and the project details dialog counted its active scheduled messages
  there too, instead of under the project it was filed under.
- Clicking the project chip on the task card ("Click to show only Work")
  filtered to the real project, where the task is not listed, so it vanished.
- Opening the task directly (no `from` in the URL) made "back" and prev/next
  navigate the real project's list, which does not contain the task.
- The achieved (packed) task manager only found it under its real project, and
  the daily report listed it in the real project's section.

## Root cause

The override was introduced for the task list only (`GET /api/tasks` grouping
and `resolveTaskDisplayProjectId` on the client). Every other place answering
"which project is this task in, for the user" kept reading `projectId` or
`task.project`, so the same question had different answers across views.

## Fix

Those views now use the display project (`secondProjectId ?? projectId`): the
project status and scheduled-message counts, the task card project chip, the
task detail back link, the achieved task search filter and result project, and
the daily report's per-project sections. The count queries fall back to
real-project grouping on schemas without `second_project_id`, where it is
equivalent. Runtime paths (daemon routing, worktree cleanup, delete cascades,
ownership checks) intentionally keep the real `projectId`, and API callers that
need it ask with `project_scope=real`.

## How to avoid next time

- When adding a display-only override of a grouping key, grep every query and
  client helper that groups, filters, labels, or links by the original key for
  the same user-facing concept (lists, counts, chips, back links, search
  filters, reports) and switch them together.
- Classify each hit explicitly as user-facing (use the display key) or runtime
  (keep the real key) instead of relying on whichever default a caller gets.
