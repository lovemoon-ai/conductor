---
"@love-moon/conductor-cli": patch
---

Report a Fire that dies inside its tmux session instead of leaving the task
hanging. In tmux mode the daemon's child is the short-lived `tmux new-session`
client, not the Fire, so an abnormal death (crash, OOM, SIGKILL) went unreported
and the task sat at `running` until reconcile relabelled it as a user stop. The
Fire now records its own exit code into its log under a per-launch nonce, and the
liveness reaper classifies the death from that marker and publishes a terminal
status with the real cause.
