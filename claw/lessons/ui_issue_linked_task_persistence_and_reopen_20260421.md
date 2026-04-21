# Symptom

- An issue lost its task entry point after the linked task moved to `killed` or `completed`.
- Moving a done issue back to `doing` could not continue the existing task; the issue no longer had a durable issue-to-task link.

# Root Cause

- Issue APIs only exposed `activeTask`, which was derived from active task statuses rather than from the persistent `task.issueId` relation.
- Issue status transitions only handled `todo -> doing` task creation and `doing -> done` task stop; they had no path to reopen an issue by restarting its linked stopped task.

# Fix

- Added persistent `linkedTask` loading and serialization for issue list, detail, and mutation responses while keeping `activeTask` semantics unchanged.
- Updated issue state transitions so `done -> doing` restarts the linked stopped task in place when it still exists, and only spawns a new task when no linked task remains.
- Updated issue frontend types, store normalization, and issue card rendering so historical linked tasks remain openable and visibly marked as non-active.
- Added API, store, and UI regression tests for killed/completed linked tasks and reopen behavior.

# How To Avoid Next Time

- Treat lifecycle state and ownership relation as separate concepts; terminal status should not erase durable linkage.
- When a feature depends on “current” and “latest related” entities, model both explicitly in API responses instead of overloading one field.
- Add transition tests for both forward progress and reopen/retry flows whenever issue or task state machines change.
