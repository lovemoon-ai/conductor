# stable: app-sdk ChatView misses the final AI reply when realtime broadcast drops it (2026-05-22)

## Symptoms
- Third-party apps embedding `@love-moon/app-sdk/react`'s `ChatView` (observed first in `arxiv-radar`'s paper chat) sometimes lose the AI's final reply.
- The user message echoes correctly, runtime status indicator runs through "thinking", then `replyInProgress` flips to `false` — but **no assistant bubble appears**.
- Refreshing the page shows the reply correctly, confirming the message did persist to Conductor's task history.
- `GET /api/conductor/tasks/:id/messages` always returns the reply; the loss is strictly on the realtime SSE / WS path.

## Root Cause
The realtime path from Fire → Conductor → BFF → browser is not guaranteed end-to-end. Several backend paths can swallow the final `task_sdk_message` envelope without persisting it to the WS connection observed by the SDK:

1. **Multi-instance Conductor without a pub/sub backplane.** `realtimeHub` is process-local. `POST /api/agent/events` is stateless HTTP and can land on a different instance than the one holding the BFF's `/ws/app` connection. The broadcast on the wrong instance has `sentTo=0` and the envelope is dropped.
2. **`commitSdkMessage`'s `duplicate=true` branch skips `projectTaskMessage`.** If Fire's durable outbox retries an `sdk_message` whose first attempt actually succeeded (network blip after server commit), the second attempt detects the dup row and silently bypasses the broadcast.
3. **WS reconnect window losses.** Conductor's `/ws/app` does not replay; envelopes emitted during a transient disconnect are gone forever even though the SDK's auto-reconnect resumes the connection.

Refresh works because it re-reads the persisted history from DB — the data is fine, only the live event delivery is unreliable. The SDK previously had no mechanism to reconcile a known-terminal moment ("reply just ended") against the latest DB state.

## Fix
Defense-in-depth in the SDK itself, so every consumer benefits without per-app patches:

1. **React layer (`ChatProvider`)** — after `task_finished` / `task_failed` / `runtime_status` with `replyInProgress` true→false, schedule `fetchHistory(taskId, { limit: 20 })` (500ms delay) and dispatch each row as `APPEND_MESSAGE`. The reducer's `dedupSorted` keyed on `message.id` makes overlap with real-time deliveries a no-op.
2. **Server SDK layer (`TasksApi.subscribe`)** — same trigger set, same 500ms delay, same 20-entry window. Injects synthetic `message_appended` events into the iterator stream via a pump+queue design so a parked `next()` wakes immediately on catch-up arrival (otherwise post-`task_finished` quiet would strand the synthetic events). Opt-out via `subscribe(taskId, { disableHistoryCatchUp: true })` for callers that want the raw stream.
3. **Reconnect recovery** — both layers also trigger an immediate catch-up on `connection_state` `reconnecting → connected`, covering envelopes lost during the WS gap.

Concurrency / safety:
- At most one in-flight catch-up per iterator. Burst triggers (runtime_status flip + task_finished in close succession) collapse via a `needAnotherCatchUp` flag.
- Each catch-up owns its own `AbortController`; consumer `iter.return()` aborts the in-flight HTTP request so the underlying socket releases promptly.
- The 500ms delay gives Conductor's HTTP → DB write → projector chain time to settle, so the history read is not racing a still-in-flight commit.
- Catch-up failure logs `console.warn` only; the live subscription is never poisoned.

Test coverage added in `modules/app-sdk/test/server/subscribe.test.ts` and `modules/app-sdk/test/react/chat-view.test.tsx`:
- terminal envelope alone triggers backfill;
- terminal envelope + already-seen real-time message → no duplicate;
- `runtime_status` flip triggers;
- `task_failed` triggers (parity with `task_finished`);
- bursty triggers collapse to ≤2 history fetches;
- catch-up REST failure does not break the live stream;
- `iter.return()` aborts an in-flight catch-up fetch;
- `disableHistoryCatchUp: true` short-circuits the whole path;
- WS reconnect triggers backfill.

## Prevention
- **Single-source delivery on a process-local hub is fragile.** Any "realtime broadcast" that does not bridge instances (Redis pub/sub, PG NOTIFY, …) must be assumed to lose events at deploy/reconnect/load-balanced boundaries. SDKs targeting such a hub should always pair the live stream with a periodic / event-triggered reconciliation against authoritative state.
- **`duplicate=true` branches must not bypass projection.** Anywhere `commitSdkMessage`-style code skips a broadcast because the row already existed, it must still re-emit the broadcast from the existing row — otherwise an outbox retry silently desyncs UIs. This is a separate follow-up fix on the Conductor backend.
- **Lazy connect + push handlers + WS gap = lost events by construction.** Even a perfect single-instance broadcast loses envelopes during reconnect. Any subscription API that promises "you'll get events" needs an `on(reconnect)` recovery hook, not just an `on(message)` handler.
- **Don't make the consumer patch `node_modules` for foundational defects.** The initial mitigation proposal was to wrap the adapter inside each third-party app's `PaperChat.tsx`. That fixes one app and leaves every other consumer broken. SDK-level defense scales; per-app workarounds rot.
- **Test the dropped-message scenario directly.** Tests where catch-up paths are exercised by manufacturing the exact failure mode ("terminal event arrives without a preceding `message_appended`") catch this class of bug. Happy-path-only test suites would still pass after the regression.
