# Copilot SDK Subprocess Uses Node 20 For JS CLI Entry

## Symptom

After `conductor update` and daemon restart, Copilot-backed CLI subprocesses
printed repeated startup failures:

```text
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Node.js v20.20.2
```

## Root Cause

`@github/copilot-sdk` defaults to launching the bundled
`@github/copilot/index.js` with the current `process.execPath`. For users
running Conductor through Node 20, that makes the Copilot subprocess evaluate a
JS entry that eventually touches `node:sqlite`, which is unavailable on Node 20.

The `@github/copilot` package also ships platform executables through optional
packages such as `@github/copilot-darwin-arm64`. Those executables avoid this
current-Node JS entry path, but Conductor was not passing them to the SDK.

## Fix

Conductor now resolves a bundled Copilot CLI path before constructing Copilot
SDK clients:

1. Prefer `@github/copilot-<platform>-<arch>` when the optional platform package
   is installed.
2. Fall back to `@github/copilot/npm-loader.js` when only the JS package is
   available.
3. Preserve explicit user configuration via `cliPath`, `cliUrl`, or
   `COPILOT_CLI_PATH`.

The fix is applied to both Copilot task sessions and Copilot quota probes.

## Avoid Next Time

When wrapping third-party SDKs that spawn their own CLI, check whether the SDK
launches a JS file through `process.execPath`. If the upstream package also
ships platform executables, prefer those by default and keep tests that assert
the JS `index.js` path is not selected implicitly.
