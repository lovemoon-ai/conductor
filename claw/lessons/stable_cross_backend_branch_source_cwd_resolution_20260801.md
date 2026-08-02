# stable: Cross-backend branch must resolve cwd from the source session

## Symptom

`New task from this` immediately killed Claude-to-Codex successor tasks with
`new task failed: Could not resolve resume cwd`. The source tasks continued to
run normally and their working directories were present in the daemon session
store.

## Root cause

The share-link handoff correctly starts a fresh session on the target backend,
but the daemon also used that target backend to resolve the source session's
working directory. Provider session IDs are namespaced by backend, so resolving
a Claude session ID through Codex cannot recover its cwd.

Explicit project paths, worktree config, and source session file paths returned
earlier from the fallback chain and masked the defect. Default-project Claude
Fire tasks had none of those values and exposed it.

## Fix

Keep the share-link handoff for conversation context, but resolve workspace
continuity with `source_backend_type` and the source session ID. The target
backend still starts a brand-new session in the resulting directory.

The daemon regression test now models Claude -> Codex without project cwd,
launch-config cwd, or source session file path and asserts that source-session
resolution supplies the spawn cwd.

## Prevention

Treat conversation handoff and workspace handoff as separate contracts:

- conversation context belongs to the new target session;
- workspace identity belongs to the source task.

Cross-backend tests must remove earlier cwd fallbacks when their purpose is to
exercise provider session resolution; otherwise a configured project path can
turn the test into a false positive.
