# stable: npm-installed CLI fails node-pty verification on macOS when `spawn-helper` loses execute permission (2026-03-23)

## Symptoms
- Users running the public installer on macOS `darwin-arm64` could finish the global npm install and successfully run `conductor version`, but the installer still ended with:
- `node-pty verification failed ... Error: posix_spawnp failed.`
- The install script then reported `Conductor CLI was installed, but node-pty is not usable.`

## Root Cause
- The failure was not the package download or the CLI entrypoint itself; it was the post-install PTY smoke test.
- In some npm-installed environments, `node-pty`'s bundled `prebuilds/darwin-arm64/spawn-helper` landed without execute bits (`0644` instead of `0755`).
- Our daemon runtime already had logic to restore execute permission on `spawn-helper` before opening PTYs, but the shared install-time verification path did not reuse that repair step.
- As a result, the installer smoke test called `node-pty.spawn(...)` before the helper was repaired and macOS surfaced the generic `posix_spawnp failed` error.

## Fix
- The shared native dependency verifier now repairs `node-pty`'s `spawn-helper` execute bit inside the installed package directory before running the smoke test.
- Added CLI regression tests to cover both:
- repairing a non-executable helper
- skipping `chmod` when the helper is already executable

## Prevention
- Keep `node-pty` helper permission repair in the shared native dependency path used by install, update, and verification flows instead of only in daemon startup.
- Add regression tests for platform-specific packaged native helper behavior whenever install verification logic changes.
- When installer failures happen after `conductor version` already works, keep the smoke test diagnostics explicit so users can distinguish "package installed" from "PTY feature unhealthy".
