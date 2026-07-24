# stable: tasks stranded in `killing`, and restarts killed by a stale fire outbox

Date: 2026-07-24
Affected tasks (prod): `6f677a71` (arXiv 论文讨论), `74273329` (pretrain 模型调研), `ee47ed23` (pi0.5 学习讨论)

## Symptom

A task showed a status that was neither `running` nor `killed`. The list rendered
a `killing 60s timeout` badge that never advanced to anything, for more than a
day. The task could not be restarted (the Restart button returned 409), could not
be stopped again (the API answered `killing` no matter what), and the only way
out was editing the production database by hand.

A second symptom appeared while repairing it: an in-place restart succeeded,
resumed its Codex session, and then killed itself ~12 seconds later.

## Root cause

Three independent defects that compound into a permanently stuck row.

### A. The daemon answers a stop it cannot perform with silence

`cli/src/daemon.js` `handleStopTask()`: when no active process and no PTY record
exist, it logged `Stop requested for task X, but no active process found`, sent
`task_stop_ack(accepted=false)`, and returned.

`task_stop_ack` is *command bookkeeping* — it clears the agent-outbox row. It is
not a status. The server, having already flipped the row to `killing`, was
waiting for a `task_status_update`, which never came. "There is nothing to stop"
IS the terminal answer, and the daemon was the only party that knew it.

Trigger in all three incidents: the fire's tmux session died during a websocket
flap (`ECONNRESET` / `ETIMEDOUT` / `pong_timeout` on m1 around 19:08–19:24), and
the user pressed Stop minutes later. `killingStartedAt` matched the daemon's
"no active process found" log line to the second.

### B. `killing` was an absorbing state

`web/src/app/api/tasks/[taskId]/route.ts`: `shouldKeepKilling` mapped a
`status: "killed"` PATCH on a row already in `killing` back to `killing`. The
intent was to stop impatient double-clicks re-sending `stop_task`. The effect was
that once A stranded a task, **no API call could ever move it again** — verified
against production: `PATCH {"status":"killed"}` returned `killing`.

### C. No server-side convergence for `killing`

`web/src/lib/tasks/stale-recovery.ts` skipped any task whose recovery host was
still connected. The stranded tasks were assigned to `m1`, which was online and
healthy — just silent about this one task. So the sweep never looked at them.
The `KILLING_TIMEOUT_MS = 60_000` that the UI counts down existed **only in the
frontend**; nothing server-side enforced it.

### D. The fire's durable outbox is stored in the fire's cwd, and restart re-uses that cwd

`modules/conductor-sdk/src/outbox/store.ts` writes to
`<projectPath>/.conductor/state/agent-upstream-outbox.<scope>.json`. An in-place
restart deliberately re-uses the previous working directory
(`CONDUCTOR_RESUME_CWD`), so events the previous run failed to deliver are still
on disk when the next run starts.

Observed on `74273329`: a `task_status_update(KILLED/fire_exit)` queued at
19:22 on 07-23 (websocket was down) survived 5 hours, and the restarted fire
flushed it 1 second after launch. The server marked the task `killed`, then
answered the newly-attached fire with `stop_task(task_already_killed)`
(`agent-upstream.ts:111`) and shot it down at 00:20:53 — 1 second after it had
finished resuming its session at 00:20:52.

Evidence that closed the loop: `killed_reason=fire_exit`, `execution_host` set to
the **new** fire (it was the deliverer), and the outbox file mtime at 00:20 with
contents `[]`.

Note this is the *client-side twin* of a hazard already documented in
`stale-recovery.ts` (see the comment on the single-request-id invariant, which
warns that a stale un-acked stop row "if the task is later reclaimed/restarted
in-place under the same taskId, [is] capable of stopping the fresh run"). The
same reasoning was never applied to the fire's own on-disk queue.

### E. Restart offered on a status the API rejects

`TaskItem.tsx` gated the restart action on `taskType` only, so a `killing` task
showed a Restart button, while the restart route requires
`RESTARTABLE_SOURCE_STATUSES` (`running` / `completed` / `killed` / `unknown`) —
which excludes `killing`. Every click 409'd, on exactly the tasks users most
wanted to rescue.

## Fix

- **A** — `cli/src/daemon.js`: the no-active-process branch now also publishes
  `task_status_update(KILLED)` using `project_id` from the `stop_task` payload,
  mirroring the tmux stop path.
- **B** — `route.ts`: added `shouldForceKilled`. A repeat kill request still
  re-affirms an in-flight stop, but once `KILLING_TIMEOUT_MS` has elapsed the
  request is honoured literally and the row goes terminal, tagged
  `user_stopped` via `tagKilledReason` (best-effort, so un-migrated
  `killed_reason` columns can never fail the PATCH).
- **C** — `stale-recovery.ts`: a `killing` task whose host is still connected now
  converges to `killed` after `CONDUCTOR_KILLING_CONVERGENCE_TIMEOUT_MS`
  (default **5 minutes**, deliberately far longer than the UI's 60s hint, which
  is a human progress cue rather than a deadline). It does **not** enqueue a
  second `stop_task` — entering `killing` already persisted one.
- **D** — `DurableUpstreamOutboxStore.dropPendingTerminalStatusEvents()`, called
  by the daemon before spawning a restart into a re-used cwd. Drops only
  terminal `task_status_update` entries; `sdk_message` is real conversation
  content and the acks are idempotent bookkeeping whose delivery usefully clears
  stale server rows.
- **E** — `TaskItem.tsx`: `showRestartAction` now excludes `killing`.

Shared helper `resolveKillingElapsedMs` (in `task-config.ts`) is used by both B
and C so they cannot drift on "how old is this kill". It prefers
`metadata.killingStartedAt` and falls back to `updatedAt`, which is sound because
a row in `killing` is not written again — `commitTaskStatusUpdate` early-returns
on every non-terminal report in that state.

## How to avoid this next time

1. **A transient state needs an owner, a deadline, and an escape hatch.**
   `killing` had none of the three: the only party that could end it was the one
   that had gone silent, nothing timed it out, and the API refused to override
   it. Any status that means "waiting for someone else" must have a server-side
   timeout *and* a manual force path.
2. **"Nothing to do" is a result, not a no-op.** A handler that discovers it has
   no work must still report the outcome. Logging locally and returning leaves
   the requester waiting forever.
3. **Do not confuse a command ack with a state report.** `task_stop_ack` clears
   an outbox row; `task_status_update` moves the state machine. Acking one while
   owing the other is how a row gets stranded.
4. **Durable queues keyed by a re-usable location are replay hazards.** If a
   queue lives in a directory and something re-uses that directory for a new
   logical run, define which events are still meaningful in the new run and drop
   the rest. Terminal events from a superseded run never are.
5. **Never gate UI affordances on a different predicate than the API.** The
   restart button and the restart route disagreed about which statuses are
   restartable; the button was the more permissive one.
6. **Diagnose from the executing host's logs, not from DB fields.** The initial
   diagnosis from `execution_host` alone ("the stop went to the wrong machine")
   was wrong. `m1`'s daemon log disproved it in one line and pointed straight at
   A. `claw/sop/diagnose-task.md` already warns that `agentHost` is logical
   ownership, not the live executor — the corollary is that neither field is
   evidence about *what a host actually did*.

## Detection

```sh
# stranded tasks (should be 0 outside a ~5 minute convergence window)
sqlite3 /opt/conductor/conductor.db \
  "SELECT id, title, agent_host, datetime(updated_at/1000,'unixepoch')
   FROM tasks WHERE status='killing';"

# poison pills waiting in fire working directories
python3 - <<'EOF'
import glob, json
for p in glob.glob('/Users/duino/ws/fires/*/*/.conductor/state/agent-upstream-outbox.*.json'):
    entries = json.load(open(p)).get('entries', []) if open(p).read(1) == '{' else []
    for e in entries:
        if e.get('eventType') == 'task_status_update' and \
           str((e.get('payload') or {}).get('status', '')).lower() in ('killed', 'completed'):
            print('POISON', p, e.get('createdAt'))
EOF
```
