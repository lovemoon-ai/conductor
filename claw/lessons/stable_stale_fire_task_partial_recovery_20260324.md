# stable: stale fire task partial recovery (2026-03-24)

## Symptom
- Users could hit `Free plan limit reached: only 1 active fire task is allowed.` when starting a new `conductor fire`, even though the previous fire session was already gone.
- The task list and task detail pages could still show the stale fire task as `running` until a manual recovery path was triggered.

## Root Cause
- Stale fire task recovery existed, but it only ran on selected code paths.
- `POST /api/tasks` counted active tasks before running stale recovery, so a disconnected fire task could still consume the free-plan fire quota.
- Default task list bootstrap and task detail reads did not request stale recovery, so the UI could keep rendering stale `running` tasks.

## Fix
- Run stale recovery before task-limit counting in `POST /api/tasks`.
- Extract the recovery logic into a shared helper so create-task, task-list, and task-detail paths use the same behavior.
- Make default task list and task detail fetches request stale recovery, and make the task detail API honor that flag.

## How To Avoid Next Time
- When a task state needs repair logic, wire it into every default read path, not only manual refresh or diagnostics routes.
- Keep recovery logic centralized so new task entry points do not silently miss it.
- Add regression tests for both quota-enforcement paths and normal UI read paths when fixing stale-state bugs.
