# stable: New tasks are still being received during daemon shutdown, resulting in task loss (2026-03-18)

## Symptoms
- After the daemon starts shutdown (including auto-update, manual exit, signal exit), the backend may still issue `create_task` / `create_pty_task`.
- Old daemons may still start new tasks during shutdown.
- The shutdown logic then clears the local tracking, causing the newly launched tasks to become orphans, and users see task exceptions or no subsequent replies.

## Root Cause
- `shutdownDaemon()` Although `daemonShuttingDown = true` is set, the event distribution and task creation logic do not uniformly reject new tasks.
- There is also a race condition in the asynchronous path:
- Enter shutdown during project path lookup
- Enter shutdown during PTY creation

## Fix
- Once shutdown is entered in `handleEvent()`, `create_task` / `create_pty_task` will be directly rejected.
- Add a secondary line of defense in `handleCreateTask()` / `handleCreatePtyTask()` to cover race conditions in asynchronous lookup / PTY startup.
- Explicit return on rejection:
- `agent_command_ack(accepted=false)`
- Corresponding `task_status_update` or `terminal_error`

## Prevention
- The shutdown flag should not only affect the "stop logic", but must also affect the "entry receiving logic".
- Check all asynchronously created links:
- before shutdown
- after await
- after the actual spawn / create
- The shutdown test of the daemon process should cover the scenario of "receiving new commands during shutdown", not just "how to end existing tasks".