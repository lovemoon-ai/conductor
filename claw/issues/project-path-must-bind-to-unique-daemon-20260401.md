# Issue: Project path must bind to a unique daemon
Date: 2026-04-01

## Problem / Context
- A `Project` currently stores workspace path metadata as a soft mapping, but that mapping is not bound to a specific `Daemon`.
- Task creation can choose an available daemon independently of the project's path binding.
- `conductor fire` can also resolve a project through path matching and several fallbacks, which means a project can be reused even when the daemon/workspace relationship is not unique.
- The result is that a task may run on a daemon that does not own the project's expected local path.

## Current Behavior
- `Project` only carries path-oriented metadata such as `metadata.localPaths`.
- `Task` stores execution-side host information separately, so project selection and daemon selection drift apart.
- `POST /api/tasks` validates the project, then resolves `agentHost` independently.
- CLI bootstrap and path matching are best-effort and can fall back to local session state, the first project, or a default project.

## Desired Invariant
- One `Project` should bind to one unique `Daemon` for its workspace path.
- Path discovery, project binding, task creation, restart, and resume should all resolve through the same project-daemon binding record.
- If the daemon or workspace path changes, create a new project record instead of rebinding the existing one.
- If the selected daemon does not match the bound daemon for the project, the flow should fail fast instead of silently routing elsewhere.
- If the bound daemon is offline, the project should remain visible but be marked unavailable / disabled.

## Acceptance Criteria
- [ ] Project creation/binding persists a first-class daemon binding, not only a path hint.
- [ ] Changing daemon or workspace path creates a new project record instead of mutating the old binding.
- [ ] Task creation rejects any daemon selection that does not match the project's bound daemon.
- [ ] Restart/resume paths use the same project-daemon binding as task creation.
- [ ] `conductor fire` resolves an existing project through the binding record instead of falling back to unrelated projects or hosts.
- [ ] Bound projects whose daemon is offline remain visible but are marked unavailable / disabled in the UI.
- [ ] Add regression coverage for project binding, daemon mismatch handling, and project discovery from path.

## Scope
### In Scope
- Schema and migration for a durable project-daemon binding.
- API validation for project/task creation and restart/resume flows.
- CLI/bootstrap path matching and binding resolution.

### Out of Scope
- Changing task execution semantics unrelated to project binding.
- Reworking the full daemon lifecycle model.

## Risks / Dependencies
- Existing projects may already have multiple local paths or ambiguous daemon affinity, so backfill or conflict resolution will be needed.
- Schema changes will likely require migration plus data repair for projects that already exist.
- CLI and web flows must be updated together; fixing only one side will leave the invariant unenforced.

## Links
- RFC: [0022-project-daemon-workspace-binding.md](/Users/duino/ws/conductor/claw/rfc/0022-project-daemon-workspace-binding.md)
- Related lesson: [arch_project_path_bind_unique_daemon_20260401.md](/Users/duino/ws/conductor/claw/lessons/arch_project_path_bind_unique_daemon_20260401.md)
- Project schema: [web/prisma/schema.prisma](/Users/duino/ws/conductor/web/prisma/schema.prisma)
- Task creation API: [web/src/app/api/tasks/route.ts](/Users/duino/ws/conductor/web/src/app/api/tasks/route.ts)
- Project path matching: [web/src/app/api/projects/match-path/route.ts](/Users/duino/ws/conductor/web/src/app/api/projects/match-path/route.ts)
- Fire project resolution: [cli/bin/conductor-fire.js](/Users/duino/ws/conductor/cli/bin/conductor-fire.js)
