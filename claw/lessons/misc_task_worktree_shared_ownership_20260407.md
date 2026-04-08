# Task worktree shared ownership bug

## Symptom
- Restarting a worktree-backed task into `new_task` created a successor that pointed at the same on-disk worktree root.
- Deleting the source task while the successor was still active could remove the successor's live workspace.
- Deleting a running or unknown worktree task could also fail with `409` when the daemon was offline, even though the delete should have been best-effort.

## Root Cause
- The restart flow preserved the original `worktreeId` for successor tasks, so source and successor tasks could legitimately share the same worktree root.
- The delete and worktree-cleanup paths treated the current task as the sole owner of that root.
- Delete also required an online daemon for worktree-backed stop requests, instead of falling back to the stale-host handling used by the shared stop flow.

## Fix
- Added a shared-worktree lookup keyed by `worktreeId` so delete and explicit worktree cleanup can see when another task still references the same root.
- Delete now skips worktree cleanup when another task still shares the root, but still removes the task record and attachments.
- Delete no longer requires the daemon to be online before attempting a best-effort stop for worktree-backed tasks.
- Explicit worktree cleanup now rejects shared roots with `409` instead of removing a root that another task still uses.

## Prevention
- Treat worktree roots as shared ownership across restart chains, not as a single-task resource.
- Gate destructive cleanup on root uniqueness, not just on the current task record.
- Keep offline daemon recovery behavior aligned between stop, delete, and worktree cleanup paths.
