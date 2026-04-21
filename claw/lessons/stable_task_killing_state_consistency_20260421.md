# Symptom

- Users could click kill and immediately see a task as `killed` in the UI even though the backend had not actually stopped the task yet.
- In some flows, the task could still keep running or start running later, which then broke restart behavior and issue/task state expectations.
- Different clients could also disagree on the task state during the stop flow.

# Root Cause

- The stop flow treated a user kill request as a terminal state update instead of a transition request.
- Frontend and API paths could write `killed` directly before the daemon confirmed the task had really stopped.
- Some related paths used different lifecycle rules, so issue completion, realtime updates, and legacy fallback behavior did not all converge on the same state machine.
- Realtime payloads also lacked the timing metadata needed for other clients to render the `killing` state consistently.

# Fix

- Introduced an explicit `killing` transitional state and reserved `killed` for daemon-confirmed terminal state only.
- Made kill requests persist `killing` plus stop-dispatch metadata first, then wait for daemon terminal updates before showing `killed`.
- Aligned issue completion, legacy schema fallback, outbox fallback, and realtime updates with the same lifecycle rules.
- Added timeout/timer support for `killing` and synchronized the timer metadata across clients.
- Added regression tests for init-task stop, legacy schema fallback, outbox fallback failure rollback, and realtime metadata merge.

# How To Avoid Next Time

- Model task lifecycle changes as explicit state transitions, not direct terminal writes from UI-triggered API calls.
- Keep every entry point that can stop a task on the same lifecycle contract, including issue flows, fallback paths, and legacy compatibility paths.
- When adding an intermediate status, include the metadata needed for cross-client rendering in the realtime event contract at the same time.
- Add regression tests for the non-happy-path stop flows before shipping lifecycle changes.
