# Bug: Command-Optional Built-In Backend Rejected on create_task

## Symptom

Tasks using the `copilot` backend are killed within ~119ms of creation.
The task transitions: `init` → `killed` with no messages ever delivered to fire.
No `latest_status_summary` is recorded (the daemon sends `task_status_update`
without a `status_event_id`).

## Root Cause

The daemon's `handleCreateTask` (and `handleRestartTask`) guards contain a
backend-validation check:

```javascript
const hasConfiguredEntry = Boolean(configuredBackend?.commandLine);
if (!isAdvertisedBackend || (!hasConfiguredEntry && !isAllowedExternalBackend)) {
  // reject with "Unsupported backend: ..."
}
```

For command-optional built-in backends like `copilot`,
`resolveConfiguredRuntimeBackend` correctly returns an object with
`commandLine: ""` (empty string — these backends don't need a CLI command).
However, `Boolean("")` evaluates to `false`, so `hasConfiguredEntry` is false.
Since `copilot` is also not an "allowed external" backend (it's built-in), the
entire guard condition resolves to `true` and the task is rejected.

Meanwhile, `listAdvertisedBackends` correctly includes command-optional built-ins
in `SUPPORTED_BACKENDS`, so the daemon advertises `copilot` as a supported backend.
The web server sees it in the advertisement and happily routes `create_task`
commands to the daemon, which then immediately rejects them.

## Fix

Import `isCommandOptionalBuiltInRuntimeBackend` and add it as an escape hatch to
the guard:

```javascript
const isCommandOptionalBuiltIn = isCommandOptionalBuiltInRuntimeBackend(effectiveBackend);
if (!isAdvertisedBackend || (!hasConfiguredEntry && !isAllowedExternalBackend && !isCommandOptionalBuiltIn)) {
```

Applied in both `handleCreateTask` and `handleRestartTask`.

## How to Avoid Next Time

When adding new "command-optional" backends that don't require a user-configured
CLI command, ensure the daemon's create/restart guards are consistent with the
advertisement logic in `listAdvertisedBackends`. Ideally extract the
"is this backend allowed to run?" predicate into a shared helper so the
advertisement and validation paths cannot drift.
