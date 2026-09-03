# stable: Cross-daemon "New task from this" killed on arrival with "Could not resolve resume cwd"

## Symptom

Picking a daemon other than the source task's machine in the `New task from
this` dialog created a successor row that was killed about one second later.

Production evidence (2026-09-03):

- source `89926701-2c06-44d5-9334-39f7f3a9d250` — `agent_host=ubuntu`,
  executing on `conductor-fire-ubuntu-89926701-…`, project `6c83cfa0…`
  (the auto-created **default** project: `daemonHost=null`,
  `workspacePath=null`, `metadata.localPaths` has no `macmini` entry).
- successor `3cec04f1-06a3-4ba7-81bd-6066032996be` — `agent_host=macmini`,
  `status=killed`, `latest_status_summary="new task failed: Could not resolve
  resume cwd"`, created 08:03:08Z and killed 08:03:09Z.

Both daemons were online and advertised `claude`, so this was neither an
offline-host nor an unsupported-backend failure.

## Root cause

The two halves of the cross-daemon contract did not meet.

1. `web/src/app/api/tasks/[taskId]/restart/route.ts` deliberately drops the
   inherited workspace paths when an explicit `agent_host` targets a machine
   other than `sourceRunHost` (`isCrossDaemonOverride` ⇒ `successorLaunchConfig
   = {}`). Correct: `cwd`, worktree roots and repo roots only exist on the
   source machine.
2. `cli/src/daemon.js::resolveRestartCwd` then had nothing left to resolve on
   the target daemon: no launch-config `cwd`, no worktree, `getProjectLocalPath`
   returns null (the default project has no `workspacePath` and no `localPaths`
   entry for that daemon — and it returns null by design whenever the project is
   bound to a *different* daemon), no source session in the local session store
   (it lives on the source machine), and `source_session_file_path` points at a
   path that does not exist locally. The empty result hard-failed with
   `Could not resolve resume cwd`.

So for a project that is not materialized on the chosen daemon — which is always
true for default-project Fire tasks — the feature could not succeed. The route's
comment even documented that hard fail as intended ("instead of fabricating a
workspace"), but it contradicts how every other spawn path behaves:
`handleCreateTask` and `handleCreatePtyTask` both fall back to a fresh
`WORKSPACE_ROOT/<date>/<run>` directory when no project path resolves.

## Fix

`cli/src/daemon.js`: for fork modes (`fork_to_new_task` / `bridge_to_new_task`),
when the whole resolution chain comes back empty, land in a fresh
`WORKSPACE_ROOT/<date>/<timestamp>_pid_<pid>` directory — the same fallback
`create_task` uses — and log why. A fork starts a brand-new session and receives
its context through `resume_context_url`, so it needs no file from the source
machine. In-place modes (`resume_inplace`, `refresh_session_inplace`) keep
failing loudly: they must reuse the original working directory.

Also updated the route comment and the dialog's cross-daemon hint so both state
the real behavior ("…or a fresh workspace when the project is not set up there").

Regression test: `cli/test/daemon.test.js` — "forks into a fresh daemon
workspace when the target daemon holds no path for the project" models the
production payload (no `target_launch_config`, no source session file, project
`localPaths` bound to another host) and asserts the spawn cwd is under the
daemon workspace root and that no `KILLED` status is reported. It fails without
the daemon change.

## Prevention

- Workspace resolution must have exactly one fallback ladder shared by every
  spawn path. When a new path (fork/restart) reuses only part of the ladder,
  it inherits a failure mode the other paths do not have — compare against
  `handleCreateTask` before adding a hard fail.
- "Fail fast instead of fabricating a workspace" is only safe when the caller
  can act on the error. Here the row was already created and dispatched, so the
  user got a dead task card instead of a dialog error. If a request cannot
  succeed, reject it before creating the task; if it can degrade sensibly,
  degrade and log.
- Default-project Fire tasks are the canonical worst case: no project binding,
  no launch-config cwd, session state only on the origin machine. Cross-machine
  features must be tested with that shape, not with a project that has a
  `localPaths` entry (which masks the defect — the same masking that hid
  `stable_cross_backend_branch_source_cwd_resolution_20260801`).
