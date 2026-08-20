# 0034 Remote command execution across daemons

## Status

Proposed

## Owner

dang217

## Date

2026-08-20

## Summary

Add `conductor remote-exec`, which runs a single command on another daemon's
host and returns its stdout, stderr and exit code. It reuses the existing
request/response pattern over the agent WebSocket (the same shape as
`custom_commands` and `validate_project_path`), adding one new protocol event
pair (`remote_exec_request` / `remote_exec_response`), one capability
(`remote_exec`), and two HTTP routes under `/api/agents/[host]/exec`.

## Context

- Today the only way to run something on a remote daemon's machine is to open an
  interactive terminal from the web UI, which is driven by `create_pty_task`.
  There is no non-interactive, scriptable path.
- The pieces are already there: `realtimeHub` owns per-request waiters,
  `sendToAgentHost` routes by daemon name within one user's connections, and the
  CLI already authenticates to the HTTP API with the same bearer token the
  daemon uses.
- Affected packages: `cli/` (new subcommand + daemon handler) and `web/` (hub
  waiters, agent gateway case, API routes). Two packages plus a protocol change
  is why this needs an RFC.

## Goals

- Run one command on a named daemon and get output plus a faithful exit code.
- Choose the working directory on the target.
- Degrade clearly against daemons that predate the feature.
- Give the host a way to decline.

## Non-Goals

- Interactive sessions or streaming output. `create_pty_task` already covers
  that; this is deliberately request/response.
- A workspace allowlist. The account owner may already reach any path on their
  own daemons, so path restrictions here would be security theatre.
- Fan-out to several daemons in one invocation.

## Options Considered

### Option A — extend `custom_commands` with an `exec` action

- Pros: zero new protocol surface, zero new hub code.
- Cons: `custom_commands` means "run a script the host pre-registered", and
  overloading it with arbitrary argv erases that distinction. Worse, capability
  negotiation would be wrong: a daemon advertising `custom_commands` would not
  necessarily understand `exec`, so old daemons would silently drop the request
  and the caller would hang until timeout instead of getting a clean 409.

### Option B — new event pair plus its own capability (chosen)

- Pros: honest capability negotiation, so mixed-version clusters fail closed
  with a 409; the host can decline exec while keeping `custom_commands`.
- Cons: duplicates ~45 lines of waiter plumbing in `hub.ts`, matching the
  existing duplication between `aiManagerWaiters` and `customCommandsWaiters`.

### Option C — direct daemon-to-daemon connection

- Pros: no backend in the data path.
- Cons: daemons have no addressing or trust relationship with each other, and
  most sit behind NAT. Would require a whole new transport and auth model.

## Proposed Design

```
conductor remote-exec  →  POST /api/agents/{host}/exec  →  realtimeHub
                                                              ↓  remote_exec_request
                                                          daemon: spawn(argv, {cwd, env})
                                                              ↓  remote_exec_response
                                                          waiter resolves → HTTP 200
```

- **No shell.** The CLI sends argv; the daemon calls `spawn(command, args)` with
  `shell` unset. Callers who want pipes pass `-- bash -lc "..."` explicitly.
- **Two-phase by default.** A single HTTP request blocks for at most ~10s. If the
  command outlives that, the daemon returns `status: "running"` with a `runId`
  and the CLI polls `GET /exec/runs/{runId}` until its own `--timeout`. This
  keeps any one request short even for long builds.
- **Cancellation.** `DELETE /exec/runs/{runId}` sends SIGTERM, then SIGKILL after
  a grace period. `--kill-on-timeout` wires this to the CLI deadline; by default
  the command keeps running on the target.
- **Exit codes follow ssh.** The remote code passes through verbatim; 255 is
  reserved for the CLI's own failures, so `grep` finding nothing (1) is not
  confused with a network error.
- **Opt-out.** `remote_exec: false` in the daemon config (or
  `CONDUCTOR_REMOTE_EXEC=0`) stops the capability being advertised and makes the
  daemon reject requests immediately rather than letting callers time out.
- **Bounded resources.** At most 8 in-flight requests per user on the backend
  (429 past that) and 32 concurrently running commands per daemon.

## Risks

- **Perceived new attack surface.** In fact the same account can already run
  arbitrary commands on the same host through `create_pty_task`, whose
  `entrypoint_type: "custom"` branch takes caller-supplied command, argv, cwd and
  env, and whose server-side validation checks only `cols`/`rows`. The one real
  gap: on a host whose node-pty probe failed, `pty_task` is not advertised at
  all, so exec genuinely adds reach there — hence the opt-out switch.
- **Weaker audit trail than the alternatives.** `pty_task` leaves a `Task` row
  and a terminal log; `custom_commands` only runs pre-registered scripts. Exec
  writes a daemon log line (command, argc, cwd — argv deliberately omitted since
  it routinely carries secrets). A server-side audit record is left for a
  follow-up.
- **Single-instance backend.** `realtimeHub` is an in-process singleton, so this
  requires one web instance or sticky routing. Pre-existing constraint shared
  with `custom_commands` and `validate_project_path`.
- **Orphaned processes.** A command outliving the caller keeps running. Mitigated
  by the cancel route and the per-daemon concurrency cap.

## Rollout

- Purely additive; no schema changes and no new environment variables required.
- Old daemons: the backend checks the `remote_exec` capability from the connect
  handshake and returns 409 with an upgrade hint, so nothing hangs.
- Old backend with a new daemon: the daemon advertises a capability nobody asks
  about. No effect.

## Acceptance

- `conductor remote-exec --target <daemon> --workspace <path> <cmd>` returns the
  remote output and exit code.
- A command that outlives the per-request wait completes through polling.
- A daemon without the capability returns 409, not a timeout.
- A daemon with `remote_exec: false` refuses immediately.
- `DELETE /exec/runs/{runId}` stops a running command.
- Covered by daemon-handler, CLI, API-route and hub tests, plus an end-to-end run
  against a real local daemon.

## Open Questions

- Should exec runs get a persistent server-side audit record (a table, or reuse
  of the task log) rather than only a daemon log line?
- Should `--kill-on-timeout` become the default once people have used it?
