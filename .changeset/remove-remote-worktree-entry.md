---
"@love-moon/conductor-cli": minor
---

Remove `conductor task create --remote-worktree <host>`; passing it now fails
with a pointer to the replacement. Running the AI on one daemon while the code
lives on another is done only through a global AI backend:
`--global-backend <backend>@<host>` (add `--worktree` for a worktree on the
code's daemon). Note the host changes meaning: `--remote-worktree` named the
daemon holding the code, `--global-backend` names the daemon running the AI, so
create the task in the project on the code's daemon. The server refuses a caller-supplied
`launch_config.remoteWorktree`.

`conductor task create --global-backend` now takes `<backend>@<host>`, the same
form as `conductor issue start` and the web UI. The older `<host>:<backend>` is
still accepted.
