# Retention cleanup must follow a committed mutation

## Symptom

Restoring an archived closed chat can stage TTL victims and then fail with CHAT_CLOSED. The previous transaction rollback retained the victims in state while already scheduled cleanup deleted their profiles.

## Root cause

Pruning mixed state mutation with filesystem side effects before the full caller mutation had validated or its checkpoint had committed.

## Fix

Pruning only collects victims. After the mutation validates, a pre-commit hook saves their non-destructive identity records for crash-safe recovery. Only a successful checkpoint and in-memory commit may schedule profile deletion. Reserve deletion in the worker allocation queue before releasing the store queue, preserving concurrent restore ordering.

## Validation and prevention

Exercise an expired victim during a rejected archived-chat send and inject a state checkpoint failure. Resident records, checkpoint contents and profile data survive both failures; the next successful mutation performs cleanup. Keep the cleanup/restore race regression covered.
