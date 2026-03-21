# stable: PTY tasks are killed immediately when the agent host loses the `node-pty` native binding (2026-03-21)

## Symptoms
- Starting on 2026-03-20, newly created production PTY tasks on `4090` and `h20` were marked `killed` within about 100ms of creation.
- Server-side dispatch was not the failing step:
- `agent_outbox.create_pty_task` was `acked`
- task rows showed `pty_session.state=failed`
- `pid=null`
- `started_at=null`
- `closed_at` was almost identical to `created_at`
- This made the incident look like a stale-task recovery issue or a web release regression, but the failure was actually happening before `terminal_opened`.

## Root Cause
- The web/backend service was dispatching PTY creation correctly. The failure happened on the agent hosts after the daemon accepted the command.
- Both `4090` and `h20` daemon logs reported the same host-side error:
- `Failed to load native module: pty.node`
- `Cannot find module './prebuilds/linux-x64//pty.node'`
- The global pnpm installation contained the `node-pty` JavaScript package, but the Linux native module was missing, so `createPtyFn(...)` failed immediately.
- On these hosts, the effective global CLI runtime had been installed or updated without producing a usable Linux `node-pty` build artifact. With pnpm v10, that happened because the native build step was not approved or verified.

## Fix
- The fix was applied on the agent hosts, not on the production web server.
- On `h20` and `4090`, we repaired the global Conductor CLI runtime so the daemon used a working `@love-moon/conductor-cli@0.2.23` installation with a real `node-pty` native binary.
- We verified that `node-pty/build/Release/pty.node` existed on the host and that the daemon was running from the repaired pnpm global installation.
- We then created fresh PTY tasks on both hosts and verified they reached:
- `task.status=running`
- `pty_session.state=running`
- non-null `pid`
- non-null `started_at`
- In the repository, we also unified the install/update repair path so `make install-cli`, the public `install.sh`, `conductor update`, and daemon `auto-update` all rebuild and smoke-test `node-pty` before they report success.
- The daemon now probes `node-pty` during startup and withholds `pty_task` capability if the native binding cannot be loaded, so broken hosts reject PTY creation immediately instead of acknowledging first and failing later.

## Prevention
- Do not advertise `pty_task` capability at daemon startup unless `node-pty` can be loaded successfully and a real PTY spawn smoke test passes.
- The CLI installation or update path for agent hosts must explicitly rebuild and verify native dependencies instead of assuming pnpm global install is enough.
- Keep the native dependency verification in one shared helper so every install path enforces the same contract instead of reimplementing partial checks.
- Add a post-update host health check that creates a disposable PTY task before the daemon is considered healthy again.
- Persist `terminal_error.message` into task diagnostics so server-side diagnosis can show the concrete host error without requiring direct daemon log access.

## Related Findings
- The 2026-03-20 production release also exposed two independent release-process issues:
- `pkill + nohup` restarts caused a short `/ws/agent` upstream gap
- static chunk and Server Action version skew caused old-page / new-server mismatches
- Those issues are real, but they were not the root cause of this PTY incident.
