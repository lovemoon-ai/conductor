# stable: standalone `conductor fire --config-file` loops on 4002 invalid-token when daemon-injected env is present

- Date: 2026-08-27
- Severity: P1 (QA release round 20260827, scenario M2)
- Component: `cli/bin/conductor-fire.js`, `@love-moon/conductor-sdk` `loadConfig`

## Symptom

`conductor fire --config-file ~/.conductor/config-dev.yaml -- "hi"` run from a shell whose
environment carries daemon-injected `CONDUCTOR_*` vars (any conductor task shell, since the
daemon injects them into spawned processes) never delivers a reply and loops forever on:

```
[fire-ws] Disconnected from backend: reason=connection_lost close_code=4002 close_reason=invalid-token
```

The daemon started with the very same `--config-file` connects fine, which made the token look
valid and the failure look like a server-side fire-auth bug.

## Root cause

`loadConfig()` applies env overrides (`CONDUCTOR_AGENT_TOKEN`, `CONDUCTOR_BACKEND_URL`,
`CONDUCTOR_WS_URL`) **on top of an explicitly passed config file**. Fire passed
`cliArgs.configFile` to `loadConfig`/`ConductorClient.connect` but never stripped the inherited
env, so with prod env injected and a dev config file the resolution split-brained:

- `agent_token` ← env (prod token)
- `backend_url` ← env (prod URL)
- `websocket_url` ← file (dev `ws://localhost:6152/ws/agent` — no `CONDUCTOR_WS_URL` in env)

Result: fire dialed the **dev** websocket with the **prod** token → the dev agent-gateway's
`authenticateToken` failed → `4002 invalid-token` reconnect loop. (HTTP attach meanwhile went to
prod, which is why the fire host never appeared in the dev server logs.)

The daemon does not have this bug because `cli/src/daemon.js` strips those env vars when an
explicit config file is given (`envForExplicitConfigFile` in `cli/src/config-env.js`); channel,
send-file, remote-exec and entity-helpers all follow the same convention. Fire (and diagnose)
were the only two commands that never adopted it.

## Fix

In fire's `main()`, immediately after arg parsing: when `--config-file` is explicit, delete
`CONDUCTOR_AGENT_TOKEN` / `CONDUCTOR_BACKEND_URL` / `CONDUCTOR_WS_URL` /
`CONDUCTOR_BACKEND_WS_URL` from `process.env` and point `CONDUCTOR_CONFIG` at the file, so every
downstream consumer (loadConfig, ConductorClient, copilot backfill, resume bootstrap, spawned
children) resolves the whole backend/token/ws triple from one source — the explicit file.

Verified E2E: standalone fire with `--config-file` dev now attaches a dev task, holds the WS
(zero 4002), and delivers a claude "PONG" reply; daemon-brokered fire is unaffected (daemon
spawns fire via env without `--config-file`).

Note: inherited `CONDUCTOR_TASK_ID` / `CONDUCTOR_PROJECT_ID` are deliberately left alone — fire
already fails loudly and actionably ("unset CONDUCTOR_TASK_ID or use an existing task id") when
they point at a task missing on the target backend. When running the CLAUDE.md E2E flow from
inside a conductor task shell, prefix with `env -u CONDUCTOR_TASK_ID -u CONDUCTOR_PROJECT_ID`.

## How to avoid next time

- Convention: **an explicit `--config-file` must win over inherited `CONDUCTOR_*` backend/token
  env.** Any new CLI subcommand that accepts `--config-file` must strip the override vars
  (`envForExplicitConfigFile`) before calling `loadConfig`.
- When a token is rejected by one transport but accepted by another, first ask *which value each
  path actually resolved* (log/print the resolved backend_url + websocket_url + token prefix)
  before suspecting server auth. Split-brain resolution across HTTP/WS was the entire bug.
- QA/E2E runs launched from inside a conductor task inherit the production daemon's env; treat
  that as a standing hazard for any dev-config testing.
