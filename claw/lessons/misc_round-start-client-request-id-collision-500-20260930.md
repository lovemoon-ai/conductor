# Round start 500 on a client request id used by another task

## Symptom
A send that started a persistent round with a `clientRequestId` already used by
a message in another task failed with a 500, after the previous fire had
already been stopped.

## Root cause
`message.clientMessageId` is unique across all tasks, but the retry lookup only
checks the same task. The clash surfaced as an uncaught Prisma `P2002` inside
the round-start transaction.

## Fix
`startPersistentRound` checks for the id on other tasks before claiming the round
or stopping anything, and returns `409 client_request_id_in_use`. A `P2002` at
insert time (a race with that check) maps to the same 409 and releases the claim.

## How to avoid next time
Check a globally unique key against its real scope (the whole table), and do it
before any irreversible step.
