# stable: killed task keeps receiving messages from a zombie fire (2026-07-22)

## Symptom
- Online task **A** (`ea9c66ea-...`) was actively killed by the user, then a
  restart of A failed. The user launched task **B** (`fb7b7359-...`) from the
  CLI via `conductor fire --resume <same ai session>`.
- Despite being `killed`, task **A** kept receiving new AI replies in the UI.
- The user suspected that resuming the *same Claude/ai session* into B was
  "leaking" messages back into A.

## Root Cause
Three different "session" concepts were conflated:
1. **Conductor task** (`Task.id`) — the message container the UI shows.
2. **Logical session** (`Task.sessionId`, default `= taskId`) — outbox/dedup
   only; **not** used for routing.
3. **AI session / resume id** (the Claude JSONL, `--resume <uuid>`) —
   orthogonal to tasks; just tells the backend which conversation to continue.

Message routing is **100% by `taskId`** (`agent-upstream.commitSdkMessage` →
`db.message.create({ taskId })`). A fire process is bound to exactly one
`taskId` and stamps every reply with it. So B never "stole" A's messages, and
sharing an ai session id cannot cross-wire two tasks.

The real defect: **A's backend was never actually stopped.** Two paths mark a
task `killed` by writing only the DB row, with **no `stop_task` delivered** to
the agent:
- `recoverStaleDisconnectedAgentTasks` (`web/src/lib/tasks/stale-recovery.ts`) —
  the defensive/"split-brain" kill (`killedReason=daemon_disconnected`).
- The active-kill PATCH path falls back to this same defensive kill via
  `waitForTaskStopConvergence` when the target fire host's websocket is seen
  offline (`web/src/lib/tasks/task-stop.ts`).

If A's fire was still alive — its ws merely flapped, or it ran in a detached
tmux and the socket dropped without the process dying — nothing told it to
stop. It kept streaming replies stamped with A's `taskId`, so the "killed" task
A kept getting messages. `conductor fire --resume` then created a brand-new
task B (a manual fire always mints a fresh `taskId`) that resumed the same
Claude conversation — coincidental, not causal.

## Fix
Two layers, both server-side:

1. **Durable stop on the defensive kill path**
   (`web/src/lib/tasks/stale-recovery.ts`). When stale recovery flips a task to
   `killed`, also `enqueueAgentCommand({ eventType: "stop_task", agentHost:
   recoveryHost, ... })` into the agent outbox (persist-only; the host is
   believed offline). When that host's socket reconnects, the outbox drains the
   pending `stop_task` and the backend session is actually interrupted, so the
   split-brain self-heals. Outbox bookkeeping failures are swallowed so they can
   never fail the recovery itself. **The outbox row `requestId` and the envelope
   `payload.request_id` must be the SAME value** — the fire echoes `request_id`
   in its `task_stop_ack` and `acknowledgeAgentCommand` clears the row by
   `requestId`; two different UUIDs leave the row un-acked forever (re-sent every
   drain, and able to stop a later in-place-restarted run under the same taskId).

2. **Reject SDK output for already-killed tasks**
   (`web/src/lib/realtime/agent-upstream.ts`, `commitSdkMessage`). Fetch the row
   via `fetchOwnedTaskRecord` (which does NOT enforce ownership) *before*
   `ensureAgentOwnsTaskRecord` — the ownership step re-binds the task and
   rewrites `executionHost`, which must not happen on a dead row. If the status
   is already `killed`, **drop the message** (do not resurrect) and stop the
   zombie via `stopKilledTaskBackend`, which uses `enqueueAndAttemptAgentCommand`
   (attempt-now + durable persist, single shared `requestId`). This covers both
   transports: an active ws is stopped immediately, and a fire reaching us over
   the stateless HTTP `/api/agent/events` path — where `sendToAgentHost` finds no
   local socket and silently no-ops — is stopped when its socket next drains.
   The function returns `dropped: true`.

## Verification
- `cd web && npx vitest run src/lib/realtime/agent-upstream.test.ts src/lib/tasks/stale-recovery.test.ts src/app/api/agent/events/route.test.ts`
  → 18/18 pass. New coverage: defensive kill enqueues `stop_task` with matching
  `requestId`/`request_id`; `commitSdkMessage` drops a killed task's message,
  does not re-bind / rewrite executionHost, and durably enqueues the stop;
  `/api/agent/events` route drops a killed task's `sdk_message` end-to-end;
  running tasks still commit normally.
- `cd web && pnpm test` → 172 files / 1409 tests pass.
- Extended `agent-outbox` mocks in `route.test.ts`, `tasks-taskId-route.test.ts`,
  `[taskId]/route.test.ts`, `tasks-restart-route.test.ts` (new `enqueueAgentCommand`)
  and `agent-upstream.test.ts`, `agent/events/route.test.ts` (new
  `enqueueAndAttemptAgentCommand`).

## Post-review hardening
A `/code-review` pass on the first cut surfaced five issues, all fixed here:
1. **Mismatched UUIDs** in the recovery `stop_task` (outbox id ≠ payload
   `request_id`) — would never ack; unified to one `requestId`.
2. **No durable fallback** in `commitSdkMessage`'s stop — direct
   `sendToAgentHost` silently no-ops on the HTTP ingest path; switched to
   `enqueueAndAttemptAgentCommand` (attempt + persist).
3. **executionHost resurrection** — `getOwnedTask` re-bound and rewrote
   `executionHost` on the killed row; split it into `fetchOwnedTaskRecord`
   (read-only) + `ensureAgentOwnsTaskRecord`, checking `killed` before the
   mutating step.
4. **Duplicate stop** — the pre-guard `drainAgentOutboxForHost` plus a second
   direct send; the guard now short-circuits before the drain.
5. **Missing route test** — added the `/api/agent/events` killed-drop test.

## Prevention
- Any code that converges a task to a terminal state **must** either deliver a
  `stop_task` (immediately or durably via the outbox) or verifiably prove the
  backend is already dead. Writing `status=killed` to the DB alone is a
  split-brain generator.
- Treat the message-ingest path as a second line of defense: a terminal task
  must never accept new SDK output; ingest should actively re-stop the sender.
- Remember the three-session distinction: routing is by `taskId`; sharing an ai
  session id across tasks is safe by itself. When "a killed task still talks,"
  suspect an un-terminated backend, not session cross-wiring.
- Related: `claw/lessons/stable_recover_stale_split_brain_kill_20260425.md`
  (boot-time floor that prevents *false* stale kills — this lesson closes the
  *other* half: making a *true* kill actually stop the backend).
