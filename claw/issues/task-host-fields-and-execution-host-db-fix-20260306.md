# Task Host Fields And execution_host DB Fix

## Background

Task host-related fields have drifted in responsibility:

- `agentHost` is currently used as both the configured daemon target and as an input to task-type inference.
- `executionHost` is the runtime owner host that actually executes the task.
- `daemon_name` is now intended to be a human-readable display name from `~/.conductor/config.yaml`.
This overlap caused frontend display confusion and made the schema look more redundant than it really is.

## Current Responsibilities

- `agentHost`
  Stores the task's configured target host. For app-created tasks, this is the daemon selected or auto-assigned at creation time.
- `executionHost`
  Stores the current runtime owner host. It is still used by backend routing, reconnect recovery, stale-task cleanup, and diagnostics.
- `daemon_name`
  Stores a display label for UI/logging. It should not be used as a routing key or ownership key.

## Why execution_host Still Exists

`execution_host` is not just a UI field. Current code uses it for:

- runtime ownership persistence in `agent-gateway`
- stale task recovery in `/api/tasks`
- fire message routing in `/api/tasks/[taskId]/messages`
- diagnostics and connection inspection

That means `execution_host` cannot be removed safely without a broader model cleanup.

## Recommended Future Cleanup

Introduce an explicit task source field instead of inferring task type from host prefixes.

Suggested eventual model:

- `taskSource`: `app | manual_fire`
- `agentHost`: configured target host
- `executionHost`: actual runtime owner host
- `daemon_name`: display name only
