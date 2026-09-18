---
"@love-moon/conductor-cli": patch
---

Fix tmux-mode Fire launches that failed before Fire started. The daemon now
drops an inherited `TMUX`/`TMUX_PANE` at startup, so a daemon launched from
another user's tmux pane (e.g. `su` from root's session) no longer aims every
tmux call at that user's socket and fails with `error connecting to
/tmp/tmux-0/default (Permission denied)`. A launch whose tmux argv would exceed
tmux's 16KB command limit (`command too long`), such as a persistent-round
prompt with a long summary, now runs through a self-deleting 0600 launch script
instead of `bash -c <command>`.
