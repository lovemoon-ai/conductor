---
"@love-moon/conductor-cli": minor
---

Global AI backend tasks (RFC 0041) that work directly in another daemon's
project directory (`launch_config.remoteWorkspace`) now get the same
`conductor remote mcp` tools as remote-worktree tasks, bound to that
repository and starting in the project directory.

The daemon advertises `global_backend_v1` so the web app only offers a daemon
as a global AI backend when its CLI can drive another daemon.
