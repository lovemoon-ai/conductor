# Codex replies delayed until turn completion

## Symptom

Codex had finished an assistant message, but Conductor displayed it only after
the following tool or the whole turn completed.

## Root cause

The app-server sends `agentMessage` items. The adapter lowercased item types but
recognized only `message` and `agent_message`, so it missed the completion
boundary. The fake server used the older shape and hid the mismatch.

Recognizing that boundary also exposed a race: transport notifications run
concurrently, and the delta handler awaited a status update before buffering
text. A same-batch completion could therefore flush an incomplete reply.

## Fix

Recognize the app-server item type while retaining legacy aliases. Buffer each
delta before yielding to the asynchronous working-status update. Update the
fixture to use the app-server shape, and retain the existing turn fallback,
message-ID checks and compaction suppression.

## Verification and prevention

The regression test covers immediate delivery before a subsequent tool ends,
legacy aliases, duplicate and late completion, compaction, and a final delta
plus completion delivered through the real transport in one synchronous batch.
The same-batch test failed after the type-only fix and passed after reordering
delta aggregation.

In a controlled local adapter probe with a 1,500 ms following tool, delivery
changed from 1,501 ms to below 1 ms. This measures adapter delivery, not network
or browser latency. Validate fixtures against the provider's actual protocol
and test concurrent transport dispatch, not only sequential awaited handlers.
