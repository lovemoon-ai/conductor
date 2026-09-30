# Scheduled message to a persistent task dropped as "task_not_running"

## Symptom
A scheduled message to an idle persistent task whose next round could not start
(daemon offline, CLI too old, backend unsupported, runtime unavailable, stop
timeout) vanished: a one-shot schedule was marked **completed** with
`lastError: task_not_running`, and an interval schedule skipped every tick
(forever when `maxSkips` is null). The real reason was never recorded.

## Root cause
`scheduled-messages.ts` put `ROUND_START_FAILED` in the set of error codes it
maps to the "task is not running" outcome. That set is for "no fire took the
message", which is expected and benign; a failed round start is an actual error.

## Fix
`ROUND_START_FAILED` is no longer in `TASK_NOT_RUNNING_ERROR_CODES`, so it goes
through `failScheduledMessage` with the real message: a one-shot is marked
`failed`, an interval counts a failure and keeps the error text in `lastError`.

## How to avoid next time
When mapping errors to a benign outcome, list only the codes that really mean
that outcome. A catch-all for "anything from the new path" hides real failures
as success-shaped states.
