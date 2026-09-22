---
"@love-moon/conductor-cli": patch
---

`conductor remote exec` now retries a POST lost to a network error or 5xx
without running the command twice. The CLI sends a `runId`, and an upgraded
daemon (capability `remote_exec_run_id`) returns the existing run for a repeated
id. Before retrying, the CLI asks the server whether the daemon dedupes. Old
servers and daemons keep the 429-only retry.
