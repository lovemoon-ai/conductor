---
"@love-moon/ai-sdk": patch
"@love-moon/conductor-cli": patch
---

Claude no longer switches to `acceptEdits` mode when the daemon runs as root.
That fallback looked like it worked, but in a headless task it silently refused
every shell command (ssh, rsync, ...) and every read outside the project. Claude
now keeps `bypassPermissions` everywhere. As root without `IS_SANDBOX=1`, the
chat shows a warning right after "session started" telling you to add
`envs: { IS_SANDBOX: "1" }` to the conductor config (or run the daemon as a
regular user). Terminal tasks print the same hint. An `IS_SANDBOX` set in config
`envs` now also reaches terminal (PTY) claude tasks. `conductor config` always
writes `--dangerously-skip-permissions` for claude.
