# stable: pnpm ignored node-pty build disables remote terminal (2026-05-22)

## Symptoms
- Remote terminal tasks could not work online even though the daemon connected successfully.
- The daemon log showed `[pty] Disabled PTY capability`.
- The concrete load error was `Failed to load native module: pty.node` and `Cannot find module './prebuilds/linux-x64//pty.node'`.

## Root Cause
- The global pnpm installation contained the `node-pty` JavaScript package but no Linux native binding at `build/Release/pty.node` or `prebuilds/linux-x64/pty.node`.
- pnpm recorded `node-pty@1.1.0` in the global install's `ignoredBuilds`, so `node-pty`'s install script did not run and `pnpm rebuild node-pty` was a no-op.
- Conductor's repair flow allowed `node-pty` in pnpm config but did not check whether the current install had already ignored that build.

## Fix
- pnpm-based `conductor update` and daemon auto-update now run `pnpm add -g --allow-build=node-pty ...`.
- Native dependency repair now checks `pnpm ignored-builds` from the installed package context and fails with a targeted reinstall command if `node-pty` remains ignored.
- Added regression coverage for parsing ignored-builds output, failing repair on ignored `node-pty`, and daemon auto-update's pnpm install arguments.

## Prevention
- Do not treat `pnpm rebuild` exit code 0 as proof that native modules were built; verify both ignored-build state and a real smoke test.
- For pnpm installs of packages with required native modules, pass `--allow-build=<package>` during install/update, not only after the fact.
- Keep native dependency repair errors explicit so operators can distinguish missing package declarations from package-manager build-script policy.
