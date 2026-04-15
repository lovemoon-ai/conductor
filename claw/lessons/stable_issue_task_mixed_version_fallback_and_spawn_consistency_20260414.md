# Issue/task integration regressed on mixed-version databases and restart/spawn edge paths.

## Symptoms
- On deployments where `web` code is newer than the database schema, task list/detail/create/update can fail with Prisma `P2022` on `tasks.issue_id` instead of falling back to the legacy task shape.
- Restarting an `ai_task` can fail on mixed-version databases when the route reads or returns a full Task row that includes the new `issue_id` column; restarting an issue-linked task with the `new_task` strategy can also lose the original `issueId`.
- Cleaning up a stopped isolated worktree for an issue-linked task can return a task payload without `issue_id`, causing the client task store to temporarily clear the linkage.
- `PATCH /api/issues/[issueId]` could create and even dispatch a linked task before the issue status update succeeds, leaving task/issue state inconsistent when the issue write fails.

## Root Cause
- The legacy task fallback path still selected the newer `issueId` column, and missing-column detection only covered PTY-era columns (`task_type`, `launch_config`, `pty_sessions`).
- `createAndDispatchAiTask()` mixed transactional DB writes with post-create side effects in a way that did not expose a reusable DB-only path for the issue route.
- Restart and worktree routes had route-local task shapes or full-row Prisma reads that were not updated with the same mixed-version fallback and shared serialization rules as task list/detail/create.

## Fix
- Expanded missing-schema detection to include `tasks.issue_id`, removed `issueId` from the legacy fallback select shape, and normalized legacy task responses back to `issue_id: null`.
- Split AI task creation into reusable DB-artifact creation plus commit-after side effects so the issue PATCH route can create the task row and update the issue inside one transaction, then broadcast/bind/enqueue after commit.
- Switched restart and worktree responses to the shared task serializer, copied `sourceTask.issueId` into successor task creation, and added restart-specific fallbacks for source reads, in-place updates, and successor creates.
- Added regression coverage for mixed-version list/create/detail/PATCH/restart/worktree fallbacks, issue-linked restart, worktree cleanup store normalization, and issue spawn/update failure consistency.

## Prevention
- Any new task column added for issue/task integration must be treated the same way as earlier PTY mixed-version fallbacks: detection, legacy select shape, and serializer normalization must be updated together.
- Keep task serialization centralized; route-local serializers drift easily and miss new fields such as `issue_id`.
- When an API both mutates database state and triggers agent side effects, separate the DB-only phase from the post-commit dispatch phase so rollback boundaries stay explicit.
