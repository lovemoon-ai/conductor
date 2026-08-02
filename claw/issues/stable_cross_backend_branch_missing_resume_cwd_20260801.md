# P1 — Cross-backend branch fails when source cwd exists only in daemon session store

## Symptom

On 2026-08-01, two production `New task from this` operations from Claude to
Codex created successor rows and then killed them immediately:

- source `d8840af8-5089-4921-8fa4-600ba0dba7e9` (AI 陪伴) -> successor
  `351ef9f4-aea5-41fc-9ca7-6354e05c710a`
- source `fa7fa325-950d-4041-a36f-b400d9e482ad` (规划自驾旅程) -> successor
  `58be8dd7-8fa1-43b8-9ae2-53afa03f67b1`

Both successors ended in `killed` with:

```text
new task failed: Could not resolve resume cwd
```

## Runtime evidence

Both diagnostics were live. The configured/execution host `macmini` was online
and advertised both Claude and Codex, so this was not an offline-host or
unsupported-backend failure.

The daemon log recorded the failures five seconds apart:

```text
[conductor-daemon 2026-08-01T19:36:19] [restart-spawn] failure task=351ef9f4-aea5-41fc-9ca7-6354e05c710a mode=fork_to_new_task: Could not resolve resume cwd
[conductor-daemon 2026-08-01T19:36:24] [restart-spawn] failure task=58be8dd7-8fa1-43b8-9ae2-53afa03f67b1 mode=fork_to_new_task: Could not resolve resume cwd
```

The local session store contains the source Claude sessions and their real
working directories, for example:

```yaml
task_id:
  - fa7fa325-950d-4041-a36f-b400d9e482ad
project_path: /Users/wangwang/ws/fires/2026-08-01/10-42-07_pid_53251
session_id: 83a24971-6489-4419-a433-bbc0fe83beba
backend_type: claude
```

## Root cause

These are default-project Fire tasks whose task launch config and project do
not provide a persisted `cwd`. Their usable cwd is present only in the daemon's
source-backend session store.

For `fork_to_new_task`, `handleRestartTask` calls `resolveRestartCwd` using the
**target** backend (`codex`) but passes the **source** Claude session id. The
fallback therefore attempts to resolve a Claude UUID as a Codex session. It
cannot find a cwd. `source_session_file_path` is also null for Claude and there
is no configured/project cwd, so every fallback returns empty and the daemon
kills the successor before spawning Fire.

The web route does preserve `sourceLaunchConfig.cwd` when one exists, but that
does not help tasks whose cwd was learned only at runtime and stored locally by
the daemon.

## Regression origin

This regression was introduced by commit `34ae838abd3486543594c90d63d1e4f43f901b72`
(`replace ai-bridge with share-link handoff for cross-backend task restart`) on
2026-04-22 and first shipped in `v0.2.40`.

Before that commit, fork mode first resolved `sourceResumeCwd` with
`backendType: sourceBackendType`, then passed that cwd through ai-bridge and
used it as the preferred cwd for the target session. The share-link refactor
correctly removed native session translation, but changed the remaining cwd
lookup to `backendType: effectiveBackend` while continuing to pass the source
session id. That mismatched target-provider lookup is the regression.

The existing handoff test did not expose it because it supplied a project
`localPaths.default` cwd. That earlier fallback returned before the mismatched
provider/session lookup ran. Explicit project paths, worktree launch config,
and Codex source session file paths similarly mask the defect; default-project
Claude Fire tasks have none of those fallbacks and therefore reproduce it.

## Expected fix direction

For fork mode, resolve workspace continuity from source execution context, not
the target provider session namespace. Viable options include:

1. resolve using `source_backend_type` plus the source session id;
2. consult the daemon session store by source task id before provider-specific
   resolution; or
3. include the known source cwd explicitly in the restart payload.

Add a daemon regression test for a Claude -> Codex fork where launch config,
project binding, and source session file path provide no cwd, but the source
task exists in the daemon session store.

## Resolution

The daemon now resolves fork cwd with `source_backend_type` and the source
session id while continuing to start a fresh target-backend session through the
share-link handoff. The regression test models Claude -> Codex with no earlier
cwd fallback and asserts that the source session supplies the spawn directory.

## Prevention

Treat session identity and workspace identity as separate values during
cross-backend handoff. Tests should cover default-project Fire tasks as well as
tasks with explicit project/worktree cwd, because explicit cwd currently masks
this failure.
