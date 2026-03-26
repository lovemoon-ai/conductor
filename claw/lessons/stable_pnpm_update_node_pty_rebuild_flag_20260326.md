# stable: pnpm CLI update fails while repairing node-pty after install (2026-03-26)

## Symptoms
- `conductor update` could download and install the newer CLI version successfully with pnpm.
- The command then failed during `Repairing and verifying node-pty native binding...`.
- The visible error was:
- `pnpm rebuild failed: ERROR Unknown option: 'global'`
- This left users with the new package version installed, but the update command still reported failure.

## Root Cause
- The post-update native dependency repair path still used the old pnpm command shape:
- `pnpm rebuild -g node-pty`
- On pnpm v10, `rebuild` no longer accepts the global flag in that form.
- The update flow therefore failed after the install succeeded, during the node-pty repair/smoke-test phase.
- The daemon auto-update path shared the same repair helper and also dropped `cwd` when invoking buffered commands, so it could not reliably switch into the installed global package directory for pnpm rebuilds.

## Fix
- Resolve the installed global package directory before repairing native dependencies.
- For pnpm installs, run `pnpm rebuild node-pty` with `cwd` set to the installed global `@love-moon/conductor-cli` directory instead of using `-g`.
- Preserve `cwd` in the daemon auto-update buffered command helper so the same repair logic works in foreground update and daemon auto-update flows.
- Added regression coverage for both the shared native dependency helper and the daemon auto-update pnpm path.

## Prevention
- Do not assume global package manager flags remain stable across major package manager versions; prefer operating on the resolved install directory when possible.
- Keep the native dependency repair logic shared across install, update, and auto-update paths, and verify all callers preserve execution options such as `cwd`.
- Add regression tests whenever package-manager-specific repair commands change, especially for pnpm and native modules.
