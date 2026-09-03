# P2: No UI indicator when a message cannot be delivered after the executor dies

## Symptom

With a running AI task whose fire process dies abruptly, a message sent from
the app is accepted (`200 POST /api/tasks/<id>/messages`) and rendered like any
other sent message. Nothing in the UI says it was never delivered.

The backend state is correct and observable:

```
./bin/conductor-dev diagnose e88a636b-... 
Verdict: ws_or_routing_issue (high)
Summary: outbox cannot send to target agent host
- pending user: true (22s)
- outbox.latest_for_pending_user: pending (send_to_agent_host_failed)
```

The task card does flip to `killed` once stale recovery runs, so the user is not
left with a spinner — but there is no per-message "not delivered" state.

## Reproduction

1. Create an AI task and wait for the first reply.
2. `kill -9` the task's `conductor-fire.js` process (simulating a crashed
   executor; the graceful path is SIGINT and is not affected).
3. Send another message from the app.
4. Observe: message appears sent; `diagnose <task-id>` reports
   `send_to_agent_host_failed`.

## Expected

The message bubble (or the composer) should reflect the failed delivery —
e.g. a "not delivered / host offline" marker with a retry affordance — matching
what the outbox already knows.

## Environment

Local `make run-dev` build `af3c71c`, task `e88a636b-c692-453d-a158-9b5e22582519`,
daemon `qa-dev-daemon`, dev CLI `./bin/conductor-dev`.

## Severity

P2 — low frequency (requires an abrupt executor death), no data loss, and the
task status still tells the user something went wrong.
