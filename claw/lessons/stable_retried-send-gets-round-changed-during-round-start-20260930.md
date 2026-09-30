# Retried send got 409 round_changed while its own round start was in flight

## Symptom
A user message to an idle persistent task starts a new round, which first waits
(up to ~68s) for the previous fire to stop. A client that retried the send with
the same `clientRequestId` in that window got `409 round_changed`, although the
first request then delivered the message.

## Root cause
The retry dedupe looks for the stored message, which is only written in the
final transaction. Meanwhile the first request holds the round-start claim, so
the retry lost `claimRoundStart` and reported a conflict.

## Fix
The claim records the sender's `clientMessageId`. A request that loses the claim
to a claim with the same `clientMessageId` waits for it: once the message exists
it returns that message (same result as the first attempt); if the claim is
released without a message, the retry claims and starts the round itself.

## How to avoid next time
Idempotency has to cover the whole time an operation is in flight, not only the
moment after it commits. Mark in-flight work with the idempotency key.
