# SDK/CLI clientRequestId never deduped retried messages

## Symptom
Retrying `sendTaskMessage(…, { clientRequestId })` created duplicate messages.
A retried round-start message would also have started a second round.

## Root cause
The SDK put `clientRequestId` inside `metadata`. The server only reads the
top-level `clientRequestId`/`client_request_id`. The round-start branch also
never stored the id on the new round's first message.

## Fix
The SDK sends `clientRequestId` at the top level. `startPersistentRound` accepts
`messageMetadata`, and `deliverUserMessage` passes the route's merged metadata
(including `clientRequestId`), so a retry finds the existing message.

The metadata lookup in `/messages` only scans recent messages, and the
scheduler, IM and `/insert` never go through it. So `startPersistentRound` also
writes the id to the message's `clientMessageId` column. `deliverUserMessage`
and `/insert` look that column up first and return the stored message before
any round or not-running rule runs. Without this, a retry after a successful
round start saw a task in `init` and got 409 `task_not_running`, or the
scheduler appended a duplicate.

## How to avoid next time
Idempotency needs an end-to-end test: SDK body shape → route lookup → stored
record.
