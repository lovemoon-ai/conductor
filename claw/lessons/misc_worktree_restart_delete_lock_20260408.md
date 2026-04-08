# Worktree restart and delete must share the same mutation lock

## Symptom
A worktree-backed task could be deleted while a concurrent restart was already creating its successor task.

That left a window where the delete path could decide the root was unused, then remove the worktree after the restart had committed the successor.

## Root Cause
The restart path wrote the successor task in its own transaction but did not take the same task-row mutation lock that delete/manual cleanup used for shared worktree roots.

That meant the shared-root check was not serialized across restart and delete.

## Fix
- Use the same worktree mutation lock in restart transactions.
- Hold that lock while creating a successor task or performing in-place restart writes.
- Keep the shared-root delete guard and restart source mutation on the same serialized row.

## How To Avoid This Next Time
If two code paths make decisions about the same physical workspace, they need a shared lock or a single transaction boundary.

Do not rely on a one-time lookup when the actual destructive action happens later in a separate transaction.
