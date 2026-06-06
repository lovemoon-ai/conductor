# stable: daemon-reconcile split-brain auto-kill of fire tasks (2026-06-06)

## Symptom

Three running fire-bound AI tasks were marked `killed` within ~150 ms of
each other without the user clicking anything. Task metadata showed:

```json
"killingStartedAt": "2026-06-05T23:27:11.870Z"
"killRequestId":   "<uuid>"
"reason":          "stopped_from_app"     (implicit, set by PATCH route)
```

`reason: stopped_from_app` made it look like a UI-initiated kill, but the
user did not interact with the kill button. The three kills happened ~70 s
after the tasks were created, all in the same daemon reconcile tick.

## Root Cause

### Layer 1 — environment: two dev daemons claim the same `daemon_name`

The user had **two** `conductor daemon` processes running, both reading
`~/.conductor/config-dev.yaml` (which sets `daemon_name: debug`). They
both registered to the backend as `agentHost="debug"`:

```
PID 88655: worktree 9ee22a / cli/bin/conductor.js daemon
PID 93570: worktree a3daaa / cli/bin/conductor.js daemon
```

Backend allows only one WS connection per `(userId, agentHost)`, so the
two processes alternated owning the socket every ~10 s
(`close_code=1005 reason=connection_lost` in the daemon log on a
metronome).

Evidence that two daemons spawned the killed tasks:
- `7568bf03` and `3b6e3bee` were created with cwd
  `…fires/2026-06-06/<ts>_pid_88655/…`
- `7baeed06` was created with cwd
  `…fires/2026-06-06/<ts>_pid_93570/…`

### Layer 2 — daemon `reconcileAssignedTasks` doesn't tolerate co-daemons

`cli/src/daemon.js:2905-2972` runs on every WS reconnect:

```js
const tasks = await fetch(`${BACKEND_HTTP}/api/tasks`).json();
const assigned = tasks.filter((t) =>
  t.agent_host === AGENT_NAME &&
  (t.status === "running" || t.status === "unknown") &&
  Date.now() - new Date(t.created_at) >= RECONCILE_GRACE_PERIOD_MS,
);
const localTaskIds = new Set(getActiveTaskIds()); // own activeTaskProcesses + activePtySessions
for (const task of assigned) {
  if (localTaskIds.has(task.id)) continue;
  await fetch(`${BACKEND_HTTP}/api/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "killed" }),
  });
}
```

The implicit assumption is *"if backend says this task is assigned to my
agent_host and I don't have a process record for it, I must have lost it
across a restart — kill it so the user isn't stuck."* That logic is
correct when `agent_host` uniquely identifies a daemon process. It is
**not** correct when two processes share that name: each process's
`activeTaskProcesses` only contains tasks **it** spawned, so the other
daemon's tasks show up as "orphaned" and get reaped.

The exact timeline that surfaced the bug:

```
23:25:56  daemon-88655 spawns task 7568bf03 (fire via tmux)
23:26:00  daemon-88655 spawns task 3b6e3bee (fire via tmux)
23:26:04  daemon-93570 spawns task 7baeed06 (fire via tmux)
23:27:01  reconcile tick: backendAssigned=2 localActive=4 markedKilled=0
          // all 3 tasks still within RECONCILE_GRACE_PERIOD_MS
23:27:12  reconcile tick: backendAssigned=3 localActive=4 markedKilled=3
          // grace expired; the daemon currently owning the WS finds
          // all 3 tasks in `assigned` but only its own in localTaskIds
          // → PATCH status=killed × 3
```

### Layer 3 — `reason: stopped_from_app` is misleading

`web/src/app/api/tasks/[taskId]/route.ts:557` hardcodes `reason:
"stopped_from_app"` for *every* PATCH that flips an AI task to `killed`,
including the one the daemon's reconcile path makes. To anyone reading the
metadata afterward, this looks like the user clicked kill. There is no
way to distinguish:

- user double-clicked the running badge in the UI
- daemon-side reconcile killed an orphaned-looking task
- a 3rd-party SDK called PATCH directly

…all of them write the same reason.

## Relationship to recent changes

**None.** This is pre-existing daemon CLI behavior; we did not touch
`cli/src/daemon.js reconcileAssignedTasks` or the PATCH route's `reason`
handling in the attached-terminal work. The kill is not introduced by
the worktree-cwd / fire-host-fallback / Space-key / `fetchTask`
refactors. It would happen on a clean checkout of `main` too, given the
two-daemons-same-name setup.

## Immediate Mitigation (user)

```bash
kill 93570   # or 88655 — pick one dev daemon, leave the other
```

Confirm only one daemon is registered as `debug` via the web UI's
connection details (or `/api/agents`). The WS-flap loop stops and the
reconcile no longer has competing local-state maps.

## Proposed Fixes (defense-in-depth)

Ordered by ROI. None are blocking.

### A. Distinguish the kill reason in the PATCH route (cheapest)

Plumb an explicit `reason` through the PATCH route so the daemon's
reconcile can stamp `daemon_reconcile_orphan` instead of borrowing
`stopped_from_app`. Forensic value is high: the next time this happens
the metadata immediately tells the operator "the daemon did this, not a
user."

- `cli/src/daemon.js reconcileAssignedTasks`: send `{status:"killed",
  reason:"daemon_reconcile_orphan"}` in the body.
- `web/src/app/api/tasks/[taskId]/route.ts`: accept an optional
  `reason` field on PATCH and forward it onto both the stop_task
  envelope and the task metadata. Whitelist allowed values so a
  malicious client can't masquerade as the daemon.
- ~10 LOC across both repos.

### B. Make reconcile tolerate co-daemons (real fix)

The daemon should not assume it is the sole owner of `agent_host`.
Options:

1. Push `agent_alive_tasks` *before* reconciling, and have the backend
   broadcast all known-alive task ids back to every daemon under that
   `agent_host`. Reconcile then knows "these tasks are alive on a
   sibling daemon, don't kill them."
2. Track a per-process `instance_id` (random uuid at boot) and have the
   backend track `(agent_host, instance_id)` → task ownership. PATCH
   `status=killed` from the daemon only succeeds when the requesting
   daemon's `instance_id` matches the task's recorded owner.

(1) reuses existing message types; (2) is cleaner but adds a schema
column.

### C. Detect duplicate `daemon_name` and refuse to start

Daemon at boot calls `/api/agents` (or a new `/api/agents/check?name=X`),
finds another `agent_host=name` already online, logs a fatal error and
exits. Prevents the foot-gun entirely.

## How to Avoid Next Time

1. **Never reuse `daemon_name` across worktrees.** Either give each
   worktree its own config-dev.yaml with a distinct
   `daemon_name` (e.g. `debug-9ee22a`), or treat the dev daemon as a
   global singleton (one shell, one tmux pane, kill before swapping
   worktrees).
2. **`stopped_from_app` is not proof of user action.** Both the UI kill
   button and `reconcileAssignedTasks` write that reason today. When
   investigating "who killed this task?", correlate the
   `killingStartedAt` timestamp against the daemon log's
   `Reconciled tasks after reconnect:` lines — a `markedKilled > 0`
   value within the same second is the smoking gun.
3. **`close_code=1005` storms in daemon logs are a top-priority
   diagnostic.** A daemon flapping at the WS layer is almost always
   either a duplicate-identity collision or a backend restart, and
   either way it tees up reconcile-driven kills.

## Diagnostic Recipe

To confirm this exact failure mode on a future task:

1. Get the task's `metadata.killingStartedAt` from `/api/tasks/:id`.
2. Convert to local time and grep the daemon log:
   `grep "Reconciled tasks after reconnect" ~/.conductor/logs/conductor-daemon.log`
3. Find the line whose timestamp matches and check `markedKilled=`.
   Non-zero ⇒ daemon-initiated.
4. `ps -ef | grep "conductor daemon"` — if you see more than one
   daemon using the same `--config-file`, that's the duplicate-identity
   smoking gun.
