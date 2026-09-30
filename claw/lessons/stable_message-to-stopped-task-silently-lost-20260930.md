# A CLI message to a completed/killed task returned 200 and was lost

## Symptom
`conductor task send` to a completed or killed task printed "Sent message …",
but no AI ever answered it. The web refuses to send in that state.

## Root cause
`appendUserMessageToTask` never checks the task status. A stale
`executionHost` was still enough to pick a target host, so the message was
stored and queued for a fire that no longer exists.

## Fix
`deliverUserMessage` returns 409 `task_not_running` for a user message to a
completed, killed or killing non-persistent task. `/messages`, the scheduler
and IM channel messages all use it. `init`/`unknown` still go through, so the
startup retry keeps working. Non-user messages, `endPersistentRound`'s summary
request and insert use their own paths and are not affected.

## How to avoid next time
A write that nobody will act on must fail loudly. Check the target's state on
the server before you return 200.
