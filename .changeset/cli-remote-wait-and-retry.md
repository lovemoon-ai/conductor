---
"@love-moon/conductor-cli": minor
---

`conductor remote exec` is safer to drive from an agent, and gains a `wait` verb.

- New `conductor remote wait -t <daemon> <runId>` re-attaches to a command that
  `exec` left running past its `--timeout`, polling and reporting it exactly as
  `exec` would have. `exec` now prints that command in its "still running" hint
  instead of a raw API path.
- `exec` retries the initial request on `429 too many concurrent remote exec
  requests` with backoff (up to ~15 s), so a burst of parallel short commands no
  longer fails outright. Other errors are still not retried: a 5xx may already
  have started the command.
- `exec` and `wait` handle SIGINT/SIGTERM: the run id is printed before exiting,
  and with `--kill-on-timeout` the remote command is cancelled as well. Before,
  a tool timeout that killed the CLI silently orphaned the remote process.
