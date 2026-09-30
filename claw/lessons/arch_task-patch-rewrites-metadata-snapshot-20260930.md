# Task PATCH rewrote the metadata snapshot it read

## Symptom
A title-only edit (or any PATCH that does not touch metadata) could wipe
`persistent.roundStarting` written while the PATCH was in flight. A round start
in its stop window then failed with `round_changed` after the previous fire had
already been stopped, leaving the task killed with no new round.

## Root cause
`PATCH /api/tasks/[taskId]` always sent `metadata` to the update, falling back
to `existing.metadata` — the snapshot read at the start of the request. Writing
it back reverted every metadata change made since.

## Fix
When the computed metadata equals the stored snapshot, the field is left out of
the update (`undefined`), so Prisma does not touch it.

## How to avoid next time
Never write a field back just because it was read. Blob columns shared by
several writers (task metadata) need either "write only what changed" or the
compare-and-swap helper `updateTaskMetadata`.
