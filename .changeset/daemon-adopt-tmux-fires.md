---
"@love-moon/conductor-cli": patch
---

Adopt the tmux-detached Fire processes a previous daemon left running, instead
of judging them stale and marking their tasks `killed`.

With `fire_tmux_mode`, daemon shutdown deliberately leaves Fires alive. But a
fresh daemon started with an empty `activeTaskProcesses` map, and both stale
sweeps — `recoverStaleTasks()` on startup and `reconcileAssignedTasks()` on
websocket reconnect — decided "this task is dead" from that map alone. Every
survivor of the hand-off was therefore PATCHed to `killed` seconds after the
new daemon connected, destroying the work the hand-off exists to preserve.
This regressed three times (2026-07-23, 2026-07-31, 2026-08-31).

The daemon now hands its Fires over to its successor:

- Each tmux spawn persists a hand-off record under
  `$CONDUCTOR_HOME/daemon/fire-sessions/`. It carries the fields the liveness
  reaper cannot recompute — most importantly `exitMarkerToken`, a per-spawn
  nonce without which a successor could never read a Fire's exit code.
- Startup enumerates surviving `conductor-fire-*` sessions and re-registers
  them, so they regain the same watcher a freshly spawned Fire has. Both stale
  sweeps wait for that pass before judging anything, and also adopt in place
  any live session they find without a record.
- A session that outlived the Fire inside it is detected via its exit marker,
  killed, and reported — adopting it would strand the task at `running`.

Two failure modes that used to read as "nothing is running" are now handled
explicitly: `tmux list-sessions` failing (a wedged server, a timeout) is no
longer indistinguishable from "no sessions", and a `tmux -V` probe that fails
once at startup no longer makes the daemon blind to tmux for its whole life.
Neither authorizes a kill any more.

Also fixed along the way:

- `stop_task`, `restart_task`, `refresh_session_inplace` and duplicate
  `create_task` gated on a record's child process, which an adopted record does
  not have. Stopping an adopted task reported it killed while leaving the Fire
  running; restarting one could spawn a second Fire into the same worktree.
- `Recovered N stale task(s) to killed` counted candidates rather than
  successes, so it claimed recovery even after the PATCH returned 409 or 500.
- Tasks whose spawn is still in flight are no longer eligible for stale kills.

Behaviour outside `fire_tmux_mode` is unchanged.
