# Worktree delete cleanup must be durable, not synchronous

## Symptom
Deleting a worktree-backed task, or deleting a project that contains isolated worktree tasks, could either:

- depend on the daemon being online and understanding the cleanup protocol, or
- leak the worktree entirely after the DB rows were removed.

That made deletion brittle during daemon outages and rolling upgrades, and it could leave orphaned worktree directories on disk.

## Root Cause
The delete flow originally treated worktree cleanup as a request-time daemon action. That meant the API either waited for a host response or used a best-effort path that was not durable.

For project deletion, the code removed tasks and the project row but never scheduled teardown for isolated worktree tasks at all.

## Fix
- Queue `cleanup_task_worktree` in the durable agent outbox inside the delete transaction.
- Remove the request-time wait on cleanup delivery.
- Keep task and project row deletion independent of daemon liveness.
- Delete attachment directories after the transaction, as a local best-effort cleanup.

## How To Avoid This Next Time
Any cleanup that must survive daemon disconnects or rolling upgrades should be persisted first and delivered asynchronously later.

If the request must remain responsive, do not wait on a daemon ack before committing DB deletions.
