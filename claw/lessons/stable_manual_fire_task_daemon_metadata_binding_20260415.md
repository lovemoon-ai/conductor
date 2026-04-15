# stable: manual fire task must persist daemon binding separately from fire ownership (2026-04-15)

## Symptom
- A task started by manual `conductor fire` could be restarted from the web UI, but the restart flow only saw the current fire backend context and could not list the other AI backends that belonged to the same daemon.
- This showed up most clearly after the fire task stopped or restarted, when the web UI needed to reconstruct the original daemon in order to offer compatible backend choices.
- The problem was worse for default-project / unbound-project cases, where falling back to `project.daemonHost` was not reliable.

## Root Cause
- The system correctly keeps manual fire tasks distinct from daemon-created tasks:
  - `agentHost` stays on the fire host for routing
  - `executionHost` reflects the live runtime owner
- But manual fire tasks did not reliably persist a separate "original daemon" binding on the task itself.
- `cli/bin/conductor-fire.js` resolved the daemon host for project lookup, but only forwarded `daemon_name` when an explicit configured daemon name existed. If the daemon host came from env or hostname fallback, task metadata could miss that binding.
- `modules/conductor-sdk/src/client.ts` wrote `metadata.daemonName` during `createTaskSession()`, but `bindTaskSession()` did not continue persisting it, so later session-binding updates could not repair or reinforce the daemon association.
- The web task PATCH route treated `metadata` as replacement, not merge, so a naive late write of `{ daemonName }` would risk wiping unrelated metadata.

## Fix
- Resolve the effective daemon host once in `conductor fire`, then propagate it through the whole fire lifecycle:
  - task creation
  - initial `bindTaskSession()`
  - later session-binding persistence after the real backend session id is discovered
- Keep fire ownership semantics unchanged:
  - manual fire still uses its own fire `agentHost`
  - manual fire does not masquerade as the daemon
  - daemon association is stored separately in `metadata.daemonName`
- Update SDK `bindTaskSession()` so it can persist `daemonName` back to the backend.
- Change `/api/tasks/[taskId] PATCH` metadata handling from replacement to merge, so later daemon-binding repairs do not erase other metadata fields.
- Keep the frontend/project-daemon fallback only as compatibility for old tasks that were created before daemon metadata was persisted reliably.

## How To Avoid Next Time
- Do not overload `agentHost` or `executionHost` with historical daemon identity. Those fields answer routing and live ownership questions, not "which daemon does this fire task belong to".
- When a fire workflow needs sticky restart or cleanup behavior, persist that daemon association explicitly on the task.
- If metadata is used for durable task identity, PATCH semantics must be merge-safe; replacement semantics are too fragile for incremental repairs.
- Test default-project and env/hostname-derived daemon cases, not only the explicit `daemon_name` config path.
