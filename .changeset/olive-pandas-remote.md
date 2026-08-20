---
"@love-moon/conductor-cli": minor
---

Add `conductor remote-exec` for running a single command on another daemon's
host, over a new `remote_exec_request`/`remote_exec_response` daemon protocol
pair gated by a `remote_exec` capability. Supports `--workspace`, `--env`,
`--timeout` with automatic polling for long commands, `--kill-on-timeout`, and
ssh-style exit codes. Hosts can decline with `remote_exec: false` in the config.
