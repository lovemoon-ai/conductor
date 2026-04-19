# Symptom

- Moving an Issue from To do to Doing created a task, but the task did not use the project's worktree launch configuration.
- Git-backed projects lost the expected isolated worktree behavior for issue-driven task creation.

# Root Cause

- The issue status transition route only passed a basic `cwd` launch config.
- It did not include the project's `repoRoot` or `lastCommit`, and it did not pre-generate the task id required to bind the launch config to a worktree id.

# Fix

- Load `repoRoot` and `lastCommit` with the issue's project when handling the transition.
- Generate the task id before task creation for git-backed projects.
- Build the launch config with `buildTaskWorktreeLaunchConfig()` and pass the same id as both `requestedId` and `worktreeId`.
- Added an API regression test for To do to Doing on a bound git-backed project.

# How To Avoid Next Time

- Keep issue-driven task creation aligned with the normal create-task worktree path.
- Add regression tests for task launch config shape when changing issue status transitions.
- Audit route include/select changes whenever task launch config depends on project fields.
