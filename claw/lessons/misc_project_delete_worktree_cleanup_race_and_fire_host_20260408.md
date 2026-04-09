# Project delete worktree cleanup race and fire-host fallback

## Symptom
Deleting a project with isolated-worktree tasks could remove the DB rows before the worktree was actually torn down. Legacy manual-fire tasks could also route cleanup to the fire host when `metadata.daemonName` was missing, leaving the real worktree daemon untouched.

## Root Cause
Project delete relied on outbox delivery and did not wait for stop/cleanup convergence before deleting rows. The cleanup host resolver also fell back to `agentHost` too early for fire-host tasks, which made older rows with missing daemon metadata ambiguous.

## Fix
Project delete now stops active worktree tasks first, then performs synchronous worktree cleanup before deleting rows. The cleanup helper prefers the project daemon host for fire-host tasks when metadata is missing, and the relevant API tests cover both the project-delete path and legacy manual-fire cleanup.

## Avoid Next Time
Do not make destructive cleanup depend on later opportunistic delivery when the target resource is still live. For fire-host worktrees, prefer the durable daemon binding or project-level daemon host before falling back to the transient agent host.
