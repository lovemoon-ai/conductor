# Symptom

- Killing a daemon-launched fire task could fail with `Task ... is assigned to conductor-fire-..., not debug`.
- The task would stay in `killing` until timeout even though the stop request had already been dispatched.

# Root Cause

- Once the fire runtime claimed the task, the backend correctly treated the fire host as the task owner.
- But `conductor-fire` suppressed final status reports when it was launched by the daemon.
- The daemon still reported child-process terminal status as `debug`, so the backend rejected those updates as owner mismatches.

# Fix

- Made `conductor-fire` report terminal task status even in daemon-launched mode.
- Marked daemon-managed fire child processes and stopped the daemon from proxy-reporting their terminal status on exit or daemon shutdown.
- Added regression tests for daemon-launched fire terminal ownership and shutdown behavior.

# How To Avoid Next Time

- Keep one clear owner for terminal lifecycle updates; launcher and runtime must not both report final status.
- When ownership moves from a parent daemon to a child runtime, explicitly stop the parent from emitting terminal state for that task.
- Add kill-path tests that cover ownership handoff, remote stop, child exit, and daemon shutdown in the same flow.
