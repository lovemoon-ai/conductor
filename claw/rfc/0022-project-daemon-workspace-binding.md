# 0022 Project daemon workspace binding

## Status

Proposed

## Owner

TBD

## Date

2026-04-02

## Summary

Non-default `Project` records become daemon-bound workspace records. A project is identified by a daemon host plus a real workspace path, while `name` becomes a display label only. Tasks created under a project inherit that project's daemon and workspace path, and AI tasks also inherit the current worktree branch as their default start context. If a project needs a different daemon/path binding, the user creates a new project record instead of rebinding the existing one. Web or mobile inputs are treated as binding candidates only; the daemon or CLI that owns the workspace confirms the real path and snapshot before the project becomes bound. The `default` project lives in a separate bootstrap record/table and stays as the only daemon-agnostic fallback, and bound projects stay visible but unavailable when their daemon is offline.

## Context

- `Project` currently stores path hints in `metadata.localPaths`, which is only a soft mapping.
- Task creation can still choose a daemon independently of the project path.
- `conductor fire` can fall back to unrelated projects or even the first project when path matching fails.
- Project names are globally unique per user today, which prevents the same label from existing on different daemons.
- Existing code already hints at the desired direction, but the binding is not yet first-class:
  - `ProjectContext` can infer repo root from a local workspace.
  - daemon and fire paths already reason about `cwd`.
  - restart flows already care about the original execution daemon.

Relevant current surfaces:

- Project schema: [web/prisma/schema.prisma](/Users/duino/ws/conductor/web/prisma/schema.prisma)
- Project create / update APIs: [web/src/app/api/projects/route.ts](/Users/duino/ws/conductor/web/src/app/api/projects/route.ts), [web/src/app/api/projects/[projectId]/route.ts](/Users/duino/ws/conductor/web/src/app/api/projects/[projectId]/route.ts)
- Project path matching: [web/src/app/api/projects/match-path/route.ts](/Users/duino/ws/conductor/web/src/app/api/projects/match-path/route.ts)
- Task creation API: [web/src/app/api/tasks/route.ts](/Users/duino/ws/conductor/web/src/app/api/tasks/route.ts)
- Task restart API: [web/src/app/api/tasks/[taskId]/restart/route.ts](/Users/duino/ws/conductor/web/src/app/api/tasks/[taskId]/restart/route.ts)
- Fire project resolution: [cli/bin/conductor-fire.js](/Users/duino/ws/conductor/cli/bin/conductor-fire.js)
- SDK workspace context: [modules/conductor-sdk/src/context/project_context.ts](/Users/duino/ws/conductor/modules/conductor-sdk/src/context/project_context.ts)

## Goals

- Make non-default projects daemon-bound and workspace-bound.
- Allow the same project name to exist on different daemons as different projects.
- Make project-bound task creation deterministic: project -> daemon -> workspace path.
- Make AI task creation default to the project workspace path and its current worktree branch.
- Keep `default` as a bootstrap fallback, not as the normal workspace model.

## Non-Goals

- Reworking task execution semantics that are unrelated to workspace binding.
- Allowing a non-default project to freely hop between daemons without creating a new binding.
- Removing the `default` project from the product.
- Changing runtime host ownership semantics beyond what project binding requires.

## Options Considered

### Option A: Keep `metadata.localPaths` as the source of truth

- Pros
- Minimal schema change.
- Works with current path matching code.

- Cons
- Still a soft mapping.
- Cannot enforce daemon uniqueness.
- Cannot safely support duplicate project names across daemons.

### Option B: Make daemon + workspace path the primary project identity

- Pros
- Encodes the actual invariant in the schema and API.
- Lets the same project label exist on different daemons.
- Makes task creation and resume/restart deterministic.

- Cons
- Requires schema migration and backfill.
- Existing UI and CLI flows must be updated together.

## Proposed Design

### 1. Project identity

- Add first-class fields to `Project` for the bound daemon and bound workspace path.
- Treat the pair `(daemon host, real workspace path)` as the canonical identity for non-default projects.
- Keep `name` as a display label only.
- Binding fields are immutable once created; a new binding means a new project record.
- Add explicit columns for workspace snapshot data such as repo root, branch, last commit, and file count. Keep JSON metadata only for rare extras.

Recommended shape:

- `daemonHost`: the daemon routing key that owns the workspace
- `workspacePath`: the real path on that daemon
- `repoRoot`: optional git repo root
- `worktreeBranch`: optional current branch snapshot
- `isDefault`: whether this is the special daemon-agnostic project

### 2. Default project

- Keep `default` as the only daemon-agnostic project, but store it in a separate bootstrap record/table from bound projects.
- It remains the bootstrap and fallback bucket.
- It does not participate in the daemon/path uniqueness rules.
- All non-default projects must have a bound daemon and a bound workspace path.

### 3. Project creation / binding flow

- Project creation becomes an upsert around the daemon-bound workspace identity.
- The authoritative creation/binding surface should receive:
  - daemon host
  - current workspace path
  - optional name / description
  - optional workspace snapshot metadata
- The browser may collect a path through a text field or desktop folder picker, but that value is only a candidate path.
- The daemon or `conductor fire` is the authority that verifies the path exists locally and turns the candidate into the confirmed binding.
- The daemon/CLI should resolve the real local path with `realpath`, verify the directory exists, and capture bind-time snapshot data from the same local workspace.
- The backend should persist only the daemon-confirmed path and snapshot data; if the browser candidate differs from the daemon-confirmed value, reject the request instead of guessing.
- If the selected daemon is offline, the bind request cannot complete for a non-default project.
- If a project with the same daemon host and workspace path already exists, reuse it and update its display fields instead of creating a duplicate.
- If the daemon host or workspace path changes, create a new project record instead of mutating the existing binding.

### 4. Path matching

- `matchProjectByPath` should match only within the same daemon host.
- Path matching must compare against the bound workspace path, not against soft metadata mirrors.
- If the current daemon/path pair does not match an existing non-default project, `conductor fire` should create a new bound project instead of falling back to a different project.

### 5. Task creation

- When a task is created from a bound project, the project's daemon becomes the task target.
- If the caller supplies an explicit daemon that does not match the project's bound daemon, the request should fail instead of silently overriding the binding.
- For AI tasks:
  - `launchConfig.cwd` should default to the project's workspace path.
  - the current worktree branch should be included as the start context or metadata snapshot.
  - if the project is not bound or the bound daemon is offline, creation should fail fast.
- For PTY tasks:
  - the same project daemon binding should be used as the execution host.
  - `launchConfig.cwd` should also default to the project workspace path.

### 6. Restart / resume

- Restart and resume flows must stay on the original project binding.
- They should not be allowed to silently pick another daemon just because one is online.
- If the bound daemon is unavailable, the flow should fail clearly instead of manufacturing a new workspace binding.

### 7. API / UI changes

- Remove independent daemon selection from project-bound task creation.
- Show daemon host and workspace path together anywhere projects are listed.
- Show bound projects whose daemon is offline as unavailable or disabled, but do not hide them.
- Keep project IDs as the URL / routing key; names are no longer enough to disambiguate.
- The create project dialog should collect a candidate daemon/path, but the project only becomes bound after daemon/CLI confirmation.
- Desktop may offer a folder picker as a convenience to prefill the candidate path.
- Mobile should stay with manual path input, but it is still only a candidate until daemon confirmation.

### 8. Compatibility and migration

- Keep `metadata.localPaths` as a temporary compatibility mirror during rollout if needed.
- Backfill existing projects by migrating the strongest existing path hint into the new binding columns.
- Ambiguous legacy projects should be flagged for rebind instead of guessed.

## Risks

- Existing projects may have ambiguous or stale path hints.
- Duplicate project names will become normal, so all UI surfaces need disambiguation.
- Offline daemon availability becomes a hard dependency for bound projects.
- A schema migration is required, and the fallback path needs a clean backfill strategy.

## Rollout

- Add the new binding columns and any required uniqueness constraint.
- Backfill from the existing path metadata and known daemon association.
- Switch `matchProjectByPath`, project creation, and task creation to the new binding service.
- Update `conductor fire` so it no longer falls back to unrelated projects.
- Update task create / restart UI to stop treating daemon as an independent choice for bound projects.
- Keep compatibility mirrors until the older path-metadata flows are no longer needed.

## Acceptance

- The same project name can exist on different daemons as distinct projects.
- A non-default project always has exactly one bound daemon and one bound workspace path.
- Task creation under a project always uses that project's daemon and workspace path.
- AI tasks under a project default to the project workspace path and its worktree branch snapshot.
- `conductor fire` never resolves a different project just because the current daemon/path did not match.
- `default` remains available as the only daemon-agnostic bootstrap project.
