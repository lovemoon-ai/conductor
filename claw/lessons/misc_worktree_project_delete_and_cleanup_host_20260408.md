# Worktree project delete and cleanup host selection need to be serialized

## Symptom
Project deletion could queue `cleanup_task_worktree` for a task that was still active, or for a restart chain that shared the same worktree root, and then delete the task rows before the daemon had a chance to succeed.

Manual worktree cleanup also held the transaction open while waiting for daemon confirmation, which kept the worktree mutation lock and DB connection occupied until timeout.

Cleanup routing for manual-fire tasks could fall back to the fire host instead of the original daemon recorded in task metadata.

## Root Cause
The delete flow used a single pre-delete task snapshot and treated worktree cleanup as a standalone action, without first stopping active tasks or deduplicating cleanup by worktree root.

The cleanup host selection logic also ignored `metadata.daemonName`, so manual-fire tasks could be routed to the wrong host.

The manual cleanup route waited on daemon confirmation inside the transaction instead of releasing the lock before waiting.

## Fix
- Stop active worktree tasks before queuing cleanup during project delete.
- Deduplicate cleanup by worktree root so restart chains only enqueue one cleanup.
- Resolve cleanup hosts from `metadata.daemonName` first for manual-fire tasks.
- Move manual cleanup waiting outside the transaction.

## How To Avoid This Next Time
If a route depends on daemon confirmation, keep the durable DB mutation and the blocking wait separate.

If a task can exist in a restart chain, key cleanup decisions by the actual worktree root, not by one snapshot of the task list.
