---
"@love-moon/conductor-sdk": patch
"@love-moon/conductor-cli": patch
---

Time out stalled WebSocket handshakes so a fire can no longer wedge forever
mid-reconnect, and let an in-place restart replace a task's tmux fire that the
server sees as disconnected instead of refusing with "task already active".
