# stable: daemon inherited root's `TMUX` env, every tmux-mode Fire launch failed with Permission denied

- Date: 2026-09-18
- Component: `cli/src/daemon.js` (`startDaemon`, `spawnFireProcess`, tmux probes)
- Case: task `5b23df19` on daemon `l20-yy`; also `1750b098`, `e30b48e7`
- Diagnosis: `claw/issues/stable_task_5b23df19_daemon_inherited_root_tmux_env_restart_fail_20260918.md`

## Symptom

On one host, every restart, new persistent round and create_task was `killed` within ~2s:

```
exited with code 1: error connecting to /tmp/tmux-0/default (Permission denied)
```

The daemon stayed online and connected, so it looked like the task was broken, not the host.

## Root cause

- After a failed auto-update, someone reinstalled the CLI and started the `yy` daemon (`fire_tmux_mode: true`) with
  `su yy` from **root's** tmux pane. `su` without `-` keeps the environment, so the daemon inherited
  `TMUX=/tmp/tmux-0/default,1600,1` and `TMUX_PANE=%1`.
- With no `-L`/`-S`, tmux uses the socket in `$TMUX` before the per-uid default (`/tmp/tmux-1000/default`). Every
  tmux call from the daemon (`new-session`, `has-session`, `list-sessions`, `kill-session`) inherited
  `process.env`, so each one tried root's socket and got EACCES.
- The daemon had no code that removed the launching shell's tmux context.

A second effect: `has-session`/`list-sessions` failing with exit 1 counts as a "conclusive, no such session"
result. So under this env the reaper and adoption would also have misjudged live Fires, and `kill-session`
would have failed without any error.

## Fix

- Code: `startDaemon` runs `delete process.env.TMUX; delete process.env.TMUX_PANE;` before resolving tmux mode. The
  daemon is a detached service and is not inside any tmux pane, so all its tmux calls, PTY shells and
  remote-exec children now use the uid's default server. Regression test in `cli/test/daemon.test.js`
  ("launches Fire inside a detached tmux session…") presets root's `TMUX` and asserts that neither the spawn env
  nor the `-e` flags contain it.
- Ops: restarted the l20-yy daemon with `env -u TMUX -u TMUX_PANE ~/.conductor/bin/conductor daemon --force --nohup`
  (through `conductor remote exec`).

## How to avoid next time

- A long-running service must not inherit terminal-session context (`TMUX`, `TMUX_PANE`, `STY`, …) from the shell
  that launched it. Strip it at the process boundary.
- Start or restart a daemon as its owner with a login shell (`su - user`) or a clean env, not `su user` from another
  account's tmux.
- When diagnosing a tmux-mode failure, compare `tr '\0' '\n' < /proc/<daemon>/environ | grep TMUX` with
  `id`. If `$TMUX` names a socket owned by another uid, this is the bug.
