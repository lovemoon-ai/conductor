# Achieved task resurrected by late daemon events

## Symptom

Packing a running task initially stored `achievedAt` and changed the task to
`killed`, but a late daemon status event could change the archived row back to
`running`. The task stayed hidden from the active list, yet Unpack failed with
`409 In-place restart requires a stopped task`. Late runtime snapshots could
also recreate `TaskRuntimeState` after packing had deleted it.

## Root cause

The pack route tore down the live session and froze the task at the API layer,
but daemon-ingest paths did not treat `achievedAt` as a lifecycle boundary.
`commitTaskStatusUpdate`, `commitSdkMessage`, runtime-status ingestion, daemon
resume binding, and `agent_alive_tasks` reconciliation could still mutate,
rebind, or revive the task after teardown.

The race was easiest to trigger by unpacking a task and immediately packing it
again while the resumed fire was still starting.

## Fix

- Drop late SDK messages and status updates for achieved tasks. Re-send
  `stop_task` only for non-terminal traffic that proves the backend is still
  alive.
- Drop late runtime snapshots before ownership rebinding or runtime-state
  persistence.
- Add `achievedAt: null` to daemon resume and alive-task reconciliation reads
  and optimistic updates.
- Allow an achieved task to resume in place even if a pre-fix late event left
  its persisted status as `running`; packing already guarantees its runtime was
  torn down.
- Add regression tests for transcript freezing, status freezing, runtime-state
  freezing, reconnect reconciliation, and stale-row Unpack recovery.

## Prevention

Treat archival markers as server-side lifecycle boundaries at every ingress
path, not only as list filters. Any daemon event handler that writes task
status, messages, runtime state, ownership, or recovery state must either:

1. query only rows with `achievedAt: null`, including the same condition in an
   optimistic update; or
2. explicitly drop achieved-task traffic before performing side effects.

For lifecycle features, E2E coverage must include an in-flight daemon race
(start/resume, immediately archive, wait for late events, then restore), rather
than only packing an already-terminal task.
