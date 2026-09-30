# CLI round start had no stale-round guard

## Symptom

Without `--expected-round`, `conductor task round start` always started a new round, even if another client had just started one. The web always sends `expectedRound`.

## Root cause

The CLI only forwarded `expected_round` when the flag was given, so CLI users had to opt in to the server's concurrency guard.

## Fix

When `--expected-round` is omitted, the CLI reads the task and sends `metadata.persistent.round`, defaulting to 1 as `readPersistentTaskState` does.

## How to avoid

If the web always sends an optimistic-concurrency token, the CLI should fill it in by default instead of leaving it to a flag.
