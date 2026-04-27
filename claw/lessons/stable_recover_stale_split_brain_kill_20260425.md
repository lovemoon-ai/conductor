# stable: recover_stale split-brain kill on a still-running Codex session (2026-04-25)

Reference diagnosis: <https://conductor-ai.top/share/ucbNwBOPkxPYAMmxL4vvlQ/plain>

## Symptom
- A task's frontend status flipped to `killed` while its backend Codex /
  `conductor fire` session kept running and continued to push messages.
- The user observed a "split-brain": the database row said the task was
  killed, but the local Codex log showed the session producing replies.
- It happened most reliably right after a Web instance restart: the next time
  any task list/detail page was loaded with `recover_stale=1` (the default),
  one or more healthy `running` tasks were marked `killed` even though the
  agent host had not actually disconnected.

## Root Cause
- `recoverStaleDisconnectedAgentTasks` in
  `web/src/lib/tasks/stale-recovery.ts` decided whether the agent was offline
  using only Web-process memory:
  - `realtimeHub.hasAgentHost(host, userId)` — whether this Web instance has
    the agent's WebSocket connection in its in-memory map.
  - `realtimeHub.getAgentDisconnectAt(host, userId)` — the in-memory
    disconnect timestamp recorded when the connection went away.
- The "offline since" timestamp had a fallback: when no `disconnectAt` was
  recorded, the code fell back to `task.updatedAt` (or `createdAt`).
- That fallback is unsafe when the realtimeHub registry was *never populated*
  for the agent on this instance. Three real-world triggers:
  1. **Fresh Web boot.** After a restart, the registry is empty and no
     `disconnectAt` exists yet. `task.updatedAt` is hours/days old, so
     `now - lastActivityMs` blows past the recovery timeout instantly and we
     kill the task.
  2. **WebSocket dropout.** If the agent socket flapped before this Web
     instance restarted, the new instance has no record either way and the
     same fallback fires.
  3. **Multi-instance / load-balanced Web.** Instance A holds the agent
     socket; instance B serves the next task list refresh. B has no record,
     marks the task killed.
- Because stale recovery writes the DB and broadcasts `task_status_update`
  directly (no `stop_task` to the agent, no ack), the agent never learns it
  was supposedly killed and keeps streaming output — the canonical
  split-brain shape.

## Fix
- File: `web/src/lib/tasks/stale-recovery.ts`.
- Capture `WEB_INSTANCE_STARTED_AT = Date.now()` at module load.
- When `disconnectAt` is missing, floor the offline-since clock at the Web
  instance start time:
  - `fallbackOfflineSince = max(lastActivityMs, WEB_INSTANCE_STARTED_AT)`.
  - `offlineSince = (typeof disconnectAt === "number") ? disconnectAt : fallbackOfflineSince`.
- Net effect: after a Web restart, every agent gets at least
  `recoveryTimeoutMs` (30s for fire, 120s for daemon by default) to
  reconnect before stale recovery is allowed to mark its task killed.
  Existing positive paths (a real disconnect with a recorded `disconnectAt`)
  are unchanged.
- Regression test: added
  `should not kill a still-running task when the Web instance has no disconnectAt record (split-brain protection)`
  in `web/src/app/api/tasks/route.test.ts`. It seeds a `running` task whose
  `updatedAt` is six hours old, leaves both `hasAgentHost` and
  `getAgentDisconnectAt` empty, and asserts the task is *not* updated.

## Verification
- `cd web && pnpm vitest run src/app/api/tasks/route.test.ts` → 36/36 pass
  (the new split-brain test plus the pre-existing positive-kill tests).
- `cd web && pnpm vitest run src/__tests__/api/tasks-taskId-route.test.ts`
  → 40/40 pass; the existing detail-route recovery path still kills when
  there is a real `disconnectAt`.
- `cd web && pnpm test` → 109 files / 817 tests pass.

## Prevention
- Stale recovery decisions must never trust an empty in-memory registry as
  proof of death. The clock has to start from a timestamp that is younger
  than the current process — `WEB_INSTANCE_STARTED_AT`, a persisted
  agent-heartbeat row, or an explicit "agent acknowledged this kill" event
  — never from `task.updatedAt`, which predates the running process.
- Any future code that auto-converges a task to a terminal state without
  going through `stop_task` + ack must include a regression test that
  asserts "manslaughter" cannot happen from a fresh Web boot.
- Long term, lift the agent presence/disconnect map out of per-instance
  memory (DB / Redis) so multi-instance Web does not depend on every
  instance individually seeing the agent socket. Until then, this boot-time
  floor is the cheap guard.
- Related earlier lessons / issues:
  - `claw/lessons/stable_recover_stale_fire_takeover_miskill_20260306.md`
    (fire-takeover host swap miskill — addressed by `executionHost`).
  - `claw/issues/stable_m1_codex_task_complete_then_stale_killed_20260311.md`
    (non-graceful fire exit + later stale recovery; this fix narrows the
    window during which "later" can be milliseconds after a Web boot).
  - `claw/issues/stable_fire_host_kill_fallback_20260421.md` (normal kill
    path now sends `stop_task` and waits for ack; this fix closes the
    parallel bypass route through stale recovery).
