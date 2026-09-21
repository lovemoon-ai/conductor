# Measure reply latency at separate boundaries

## Symptom and root cause

A blank chat can mean model execution, adapter buffering, transport delay, or
rendering work. Local event replays previously demonstrated buffering, but their
injected delays were not a measurement of production time to first text.
The application had no correlated browser send-to-reply-commit measurement.

The completion-event and historical Markdown rendering fixes already landed on
main (f6dbd6b); this change adds diagnostics on top of those fixes.

## Change

- `CONDUCTOR_DEBUG=1` on the Fire process enables `[codex-reply-latency]`
  logs. `first_delta` records `turnStartToDeltaMs` (regular turns, including boot);
  `reply_emit` records `firstDeltaToEmitMs` per assistant item. Goal-mode start
  durations are `null` when no per-turn start is available. Neither log proves
  HTTP delivery; emission is the handoff to the session message handler.
- In the browser console, `localStorage.setItem('CONDUCTOR_DEBUG', '1')`
  enables `[conductor-reply-latency]` for subsequent chat sends. Remove the key to
  disable. `sendToFirstReplyCommitMs` measures send action to the first text
  reply's React DOM commit; `sendToReceivedMs` and `receivedToCommitMs` isolate
  the websocket receipt boundary when present. `documentHidden` describes the
  document at reporting time. This is a DOM-commit proxy, not paint/visibility
  TTFT; it excludes attachment uploads before the send action and does not
  cover task-creation prompts or insert/steer actions.
- Correlate `replyTo` with the user message ID and scope by task. HTTP ack can
  arrive after the reply was received and rendered; keep the earlier timestamps.
- Diagnostics are opt-in, local, bounded to 100 entries with lazy 30-minute
  expiry, and contain no message bodies. No database schema or protocol changes.

## Prevention and verification

Use monotonic clocks within each process. Do not subtract wall clocks between
machines or label model-start-to-text as browser TTFT. Before diagnosing a
reported installation, record its version and compare with current upstream.

Tests cover early websocket/DOM completion before HTTP ack, concurrent sends,
synthetic/empty replies, cancellation, expiry, bounded storage, opt-in behavior,
privacy, and rendering an actual MessageBubble. Existing Codex completion tests
cover immediate delivery, legacy message types, duplicate completion, batched
notifications, and suppressed compaction summaries.
