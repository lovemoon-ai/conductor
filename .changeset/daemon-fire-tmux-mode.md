---
"@love-moon/conductor-cli": minor
---

Add `fire_tmux_mode` for the daemon. When enabled (via the `fire_tmux_mode: true`
key in `~/.conductor/config.yaml` or the `CONDUCTOR_FIRE_TMUX_MODE=true`
environment variable), each Fire process is launched inside a detached
`tmux new-session -d` so that it runs under the tmux server with no
parent/child relationship to the daemon. Restarting or terminating the daemon
no longer affects running Fire processes; explicit `stop_task` requests use
`tmux kill-session` to terminate the corresponding session.

If `fire_tmux_mode` is enabled but `tmux` is not installed on PATH, the daemon
logs a warning at startup and silently falls back to direct spawn instead of
failing every `create_task` with ENOENT.

If a tmux session fails to launch (e.g. duplicate session name, tmux server
crashed), the daemon now reports a terminal status to the backend instead of
leaving the task stuck on RUNNING.

Session names embed a per-spawn uniqueness suffix
(`conductor-fire-<taskId>-<base36-time><rand>`) so a re-spawn of the same task
id while a prior session is still alive does not collide. The daemon also runs
a periodic best-effort liveness reaper (default every 30s; override via
`config.TMUX_LIVENESS_POLL_MS`) that walks tmux-mode entries in
`activeTaskProcesses` and removes any whose session no longer exists, so the
in-memory map does not accumulate stale entries when Fire exits naturally
inside its session.
