---
"@love-moon/conductor-cli": patch
---

Fix `conductor fire` and `conductor diagnose` with an explicit `--config-file`
resolving `agent_token`/`backend_url` from daemon-injected `CONDUCTOR_*` env
instead of the file. Fire could dial the file's websocket with the inherited
token and loop on `4002 invalid-token`; diagnose queried the wrong backend and
404'd. An explicit config file now wins over inherited env, matching the
daemon's behavior.
