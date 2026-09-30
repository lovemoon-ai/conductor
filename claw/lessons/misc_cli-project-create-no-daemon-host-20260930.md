# misc: `conductor project create` fails unless you pass --daemon-host (2026-09-30)

## Symptom
- `conductor project create` without `--daemon-host` always failed with 409 "Binding fields require confirmed binding from daemon/CLI".
- `--create-workspace` did nothing: the directory was never created.
- When the daemon was offline, the CLI printed "Backend responded with 409" and no hint.

## Root cause
- The web dialog always sends `daemonHost` (it picks the first online daemon). The CLI sent `workspacePath` (cwd by default) but sent `daemonHost` only when the flag was given. The server checks a binding only when it gets both fields, so it rejected the request.
- The SDK's `ProjectsApi.createProject` did not pass on `createWorkspaceIfMissing`.
- The CLI searched the message text for "not reachable". The server actually says "Daemon X is offline…" with `code: daemon_offline` in the error body.

## Fix
- The CLI now defaults `daemonHost` to this machine's daemon name, using the same order as `conductor daemon`: config `daemon_name`, then `CONDUCTOR_DAEMON_NAME`, then the hostname. The workspace path is a path on this machine, so its daemon is the right one.
- The SDK now passes `createWorkspaceIfMissing` through.
- The CLI now detects the daemon-down error by `code` (`daemon_offline` / `daemon_unreachable`) and shows the server's own message, followed by the hint.

## How to avoid
- Test a CLI write command against what the server actually needs, not just the dry-run body. A defaulted field (cwd) often needs a partner field.
- Match server errors by code, not by the wording of the message.
