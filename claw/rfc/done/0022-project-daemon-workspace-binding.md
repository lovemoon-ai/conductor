# 0022 Project Daemon Workspace Binding

## Status

Implemented

## Owner

TBD

## Date

2026-04-03

## Summary

Project binding is now first-class. Non-default projects are identified by a confirmed daemon host plus a real workspace path, while the default project remains the daemon-agnostic fallback. Browser input is treated as a binding candidate until the daemon or CLI confirms the workspace, and task creation and restart now honor the project binding instead of choosing a daemon independently.

## Final Behavior

- `default` stays the only daemon-agnostic project and cannot be rebound.
- Pending projects store `bindingCandidate` metadata only and are shown as awaiting confirmation.
- Confirmed projects persist `daemonHost`, `workspacePath`, and workspace snapshot fields such as `repoRoot`, `worktreeBranch`, `lastCommit`, and `fileCount`.
- If a bound daemon is offline, the project remains visible but unavailable for task creation.
- Binding identity is immutable for existing bound projects; changing daemon or workspace requires a new project record.
- Task creation under a bound project forces the project's daemon and workspace context.
- Task restart stays on the original project binding and fails if the source daemon no longer matches the project binding.

## Constraints

- Project names are display labels, not identity.
- A confirmed project must have both `daemonHost` and `workspacePath`.
- Path matching only succeeds within the same daemon host.
- CLI and SDK may confirm bindings, but they do not invent a binding when the local workspace cannot be resolved.

## Acceptance

- Default, pending, confirmed, offline, and immutable-binding states are all represented in the web UI and API behavior.
- `conductor fire` resolves projects by daemon + workspace path and backfills the confirmed binding.
- Task creation and restart enforce the project daemon binding without silent fallback to another host.
