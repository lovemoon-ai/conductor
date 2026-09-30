# CLI send failed during the task startup race that the web retries

## Symptom
`conductor task send` right after creating or restarting a task failed with 409
`task_missing_active_fire_owner`. The web composer quietly retries for about 10s
and succeeds.

## Root cause
The retry lived only in `web/src/features/chat/store.ts`.

## Fix
`retryWhileFireOwnerMissing` in `cli/src/task-commands.js` retries that code
(backoff 0.5s→1.5s, 10s window). It wraps both `task send` and `task send --attach`.

## How to avoid next time
When a server error code is documented as "transient, retry", give every
client the retry. Keep the code stable so clients can match on it.
