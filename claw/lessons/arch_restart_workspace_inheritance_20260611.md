# Restart "new task from this" silently jumped workspace when source had a custom `cwd`

## Symptom

When a user clicked **"New task from this"** on an AI task:

- The new task correctly inherited the source's chat history (via the
  short-lived `/share/<token>/plain` handoff URL).
- BUT the new task's working directory did not always match the source's.
  - If the source was on a git worktree branch: same workspace — OK.
  - If the source was a non-worktree task whose `launchConfig.cwd` pointed at
    a subdirectory (e.g. `<project>/apps/web`), the successor was launched in
    `projectWorkspacePath` (the project root), not in the source's `cwd`.

The user expects "continue this work" to mean "continue in the same place."
Silently jumping to the project root broke that contract.

## Root Cause

`web/src/app/api/tasks/[taskId]/restart/route.ts` built the successor's
`launchConfig` like this:

```ts
const successorLaunchConfig = inheritedWorktreeLaunchConfig ?? {
  ...(projectWorkspacePath ? { cwd: projectWorkspacePath } : {}),
  ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
};
```

- The worktree branch handled itself: `inheritTaskWorktreeLaunchConfig` copies
  the source's `worktreeBranch`, and because the on-disk folder identity is
  keyed off `sanitizeWorktreeFolderName(branch)` (see `web/src/lib/tasks/worktree.ts`
  and the daemon's `buildTaskWorktreeRoot`), the successor lands in the SAME
  `.conductor/worktrees/<branch>` folder. That path was already correct.
- The fallback branch was the gap. When the source had no worktree but DID
  have a custom `launchConfig.cwd`, the fallback overwrote that `cwd` with
  `projectWorkspacePath`. There was no test pinning the inheritance, so the
  regression went unnoticed.

A secondary issue: `worktreeBranch: projectWorktreeBranch` in the fallback is
*the project's default base branch*, not an actual per-task worktree branch.
Without `worktree: true` it is ignored by both parsers — harmless, but
misleading. Left in place to avoid scope creep; called out here so future
readers don't mistake it for live behavior.

## Fix

`web/src/app/api/tasks/[taskId]/restart/route.ts`:

```ts
const sourceCwd = normalizeOptionalString(sourceLaunchConfig?.cwd);
const successorCwd = sourceCwd ?? projectWorkspacePath ?? null;
const successorLaunchConfig = inheritedWorktreeLaunchConfig ?? {
  ...(successorCwd ? { cwd: successorCwd } : {}),
  ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
};
```

Plus three new tests in `web/src/lib/tasks/worktree.test.ts` that lock in the
contract for `inheritTaskWorktreeLaunchConfig`:

1. Returns `null` for non-worktree configs (so the fallback runs and we don't
   silently produce a half-valid worktree successor).
2. Preserves the source's `worktreeBranch` (and therefore on-disk folder) so
   the successor lands in the same workspace as the source.
3. Accepts snake_case fields (so a launch_config written by an older daemon
   still inherits correctly).

## How to avoid next time

1. **Treat "workspace" as a first-class contract of restart, not an
   afterthought.** When adding any new successor-construction path,
   write the test first: "successor's resolved working directory equals the
   source's resolved working directory."
2. **Don't conflate "no worktree" with "no custom cwd."** A task without a
   worktree can still have a meaningful `launchConfig.cwd`. The fallback in
   restart should preserve it, not reset to project defaults.
3. **Cross-daemon caveat (not fixed here).** If a worktree task's successor
   is re-routed to a different daemon than the one that created the
   `.conductor/worktrees/<branch>` folder, the worktree files won't be on the
   new daemon's disk. The current restart code re-binds to `projectDaemonHost`
   only when the source is a fire task or already matches — so in practice
   this is rare — but if we ever loosen that check, also pin worktree-bearing
   successors to the source's daemon, or surface an explicit error.
4. **Worktree launch_config has 5 mandatory fields** (`worktreeId`,
   `worktreeBranch`, `projectRepoRoot`, `projectWorkspacePath`, plus
   `worktree: true`). Both web and daemon parsers refuse partial configs.
   Any code that writes a worktree launch_config must go through
   `buildTaskWorktreeLaunchConfig` — don't hand-roll partial dicts.
