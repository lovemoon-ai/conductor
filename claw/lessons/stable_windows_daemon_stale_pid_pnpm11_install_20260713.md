# Windows daemon stale PID and pnpm 11 install

## Symptom

On Windows, `scripts/run-conductor-daemon.bat` could exit before the daemon registered with the backend. The launcher printed that it was starting with `--force`, but the CLI failed with `Daemon already running with PID <pid> (access denied)`. The frontend did not show the daemon because no daemon connection was actually established.

The Windows dev installer could also complete in a misleading state under pnpm 11: temporary workspace settings allowed native build scripts, but local package overrides from `cli/package.json` were ignored, so `conductor-dev` could resolve published `@love-moon/*` packages instead of local modules.

## Root Cause

Node can return `EPERM` for `process.kill(pid, 0)` on Windows even when the PID in `daemon.pid` is stale. The daemon lock code treated any non-`ESRCH` error as an access-denied live process, so `--force` could not clear the stale lock.

pnpm 11 no longer reads the `pnpm` field in `package.json`. The Windows install script generated temporary `pnpm-workspace.yaml` files for `allowBuilds`, but did not carry over local `overrides`, so local dev installs stopped linking the repository modules.

## Fix

- On Windows, verify `EPERM` lock checks with `tasklist`; if the PID is not present, treat the lock as stale.
- Make `run-conductor-daemon.bat` default to `--force` and prefer the generated `bin\conductor-dev.cmd` shim.
- Generate temporary pnpm workspace settings with both `allowBuilds` and local `overrides`.
- Use `pnpm install --no-lockfile` in the Windows dev installer so verification does not dirty tracked lockfiles.
- Add regression tests for stale Windows PID handling.

## Prevention

When adapting install flows to a new pnpm major version, verify both "install succeeds" and "linked packages come from the intended local source." For Windows PID lock handling, treat `process.kill(pid, 0)` as a hint and confirm ambiguous errors against the Windows process table before blocking startup.
