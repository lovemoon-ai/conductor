# misc: `conductor diagnose --config-file` queries the wrong backend (env overrides beat the explicit file)

- Date: 2026-08-27
- Severity: P2 (QA release round 20260827)
- Component: `cli/bin/conductor-diagnose.js`

## Symptom

`conductor diagnose <task-id> --config-file ~/.conductor/config-dev.yaml` 404s for tasks that
clearly exist on the dev server; the dev server access log shows zero hits from the command.
Forcing `CONDUCTOR_BACKEND_URL=http://localhost:6152` reaches the dev server but then fails
`Unauthorized`.

## Root cause

Same class as the stable_fire-explicit-config-env-override-4002 P1: diagnose called
`loadConfig(args.configFile)` without stripping inherited env, and `loadConfig` applies
`CONDUCTOR_BACKEND_URL` / `CONDUCTOR_AGENT_TOKEN` env overrides on top of the explicit file. In
a daemon-injected shell both point at prod, so diagnose queried prod with the prod token and
404'd on dev task ids; overriding only the URL left the prod token → Unauthorized.

## Fix

Pass the already-existing stripped env to loadConfig:

```js
const config = loadConfig(args.configFile, { env: envForExplicitConfigFile(args.configFile) });
```

Verified: `diagnose <dev-task> --config-file config-dev.yaml` now returns the full diagnostics
payload from localhost:6152.

## How to avoid next time

Same rule as the P1 lesson: every subcommand accepting `--config-file` must resolve backend/token
exclusively from that file (`envForExplicitConfigFile`). Grep check before release:
`rg -n "loadConfig\(" cli/ | grep -v "env:"` should return no explicit-config call sites.
