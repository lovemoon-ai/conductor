---
"@love-moon/conductor-cli": minor
---

Support persistent task rounds (RFC 0039). A `create_task` carrying
`replace_existing_fire: true` releases the task's previous fire before starting
the new round instead of ignoring it as a duplicate: tmux sessions are probed
(and killed if still alive), child processes are stopped and awaited, the old
fire's terminal status is suppressed, and its undelivered KILLED/COMPLETED
events are purged from the reused directory. The tmux liveness reaper also stops
reporting a dead session for a task whose new round is still starting. The
daemon advertises this as the `persistent_round_v1` capability.
