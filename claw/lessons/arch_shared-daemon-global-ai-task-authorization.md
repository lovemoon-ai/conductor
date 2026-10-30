# Shared daemon Global AI Backend authorization

## Symptom

A user could run ordinary tasks on a shared daemon but could not select that
daemon as a Global AI Backend, even when both parties trusted each other and
the code stayed on the user's own machine.

## Root cause

RFC 0041 rejected either endpoint when it was a shared daemon. This protected
the account because a shared daemon holds a daemon_share credential on someone
else's disk. Removing the restriction alone would either leave remote requests
unauthorized or give that credential access to other machines without a task
binding.

## Fix

- Allow a shared daemon to run the AI side while the remote code daemon remains
  one of the user's own daemons.
- Keep account credentials on the user's side. Only full-token task creation
  and authorized lifecycle operations mint the server-owned Global Backend
  metadata and remote binding.
- Send X-Conductor-Task-Id on remote exec, wait, file transfer, and MCP requests.
  Verify the active share, task owner, AI host, active/unarchived task state,
  remote target, code project ownership, and code daemon's sharing status.
- Limit the cross-host exception to the remote exec and file route families.
  Preserve the existing WebSocket and daemon control host restrictions.
- Prevent shared credentials from forging bindings or renewing remote grants
  through restarts, persistent rounds, scheduled messages, or status changes.
  Guard upstream status writes and session PATCHes against concurrent task
  completion, stops, and changes to the remote binding.
- Advertise shared_ai_global_backend_v1 and check it during creation, restart,
  and later persistent rounds. When a round moves to another AI daemon, update
  its server-owned host/backend binding too.

## How to avoid next time

Model the AI endpoint separately from the code endpoint and define authorization
at the task boundary before widening a shared credential's host scope. Audit
creation, restart, continuation, automatic rounds, scheduling, and reconnect
paths together. Treat task ids as identifiers, with authorization derived from
server-owned state.

Cover both the happy path and absent, forged, inactive, revoked, mismatched,
and concurrent bindings. New protocol requirements need an advertised capability
so an older daemon is rejected before work starts.

## Verification and rollout

- 836 Web tests passed across 46 files, covering API authorization, task
  lifecycle operations, shared daemons, remote transfers, and UI selection.
- 304 CLI tests passed, including remote exec/cp/wait/MCP header propagation,
  daemon capabilities, settings, and API parity.
- Web TypeScript checking passed.
- Existing lint errors remain; touched code was checked against the baseline.
- No live two-daemon end-to-end run was performed.
- No database migration is required. Deploy the server changes and update the
  shared AI daemon's CLI before enabling this feature.

The shared machine owner can read its local credential and use remote shell
access while an authorized task is active. This feature relies on mutual trust;
it does not provide a repository sandbox or prevent credential extraction and
persistent changes during authorized execution.
