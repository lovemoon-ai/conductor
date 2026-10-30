# SDK reply promotion could restore a stopped task's remote grant

## Symptom

An SDK reply could read a Global Backend task in init, then persist after a
concurrent stop changed the task to killed. The reply's unconditional task
update restored running, making its remote grant active again. The race was
possible with and without a client message id.

## Root cause

The status-report path checked the current database status, but SDK messages
have a separate init-to-running promotion path. That path trusted an earlier
snapshot for both its database write and its running status broadcast.

## Fix

Both SDK message-id branches now share one persistence helper. Its promotion
uses a conditional updateMany requiring the stored row to remain init and,
when available in the task schema, unarchived. An update affecting zero rows
does not promote the task or broadcast running. Ordinary running-task messages
only update the message timestamp.

Existing message idempotency and unique-key replay handling are preserved.
Legacy task selects that omit achievedAt retain the status predicate without
requiring the missing field.

## Prevention and verification

Audit every writer of a permission-relevant state, including implicit state
transitions triggered by SDK output. Check eligibility atomically in the
database, and project only transitions the database actually accepted.

Permanent deterministic regressions interleave the SDK reply with killed,
killing, completed, and archived state changes for both message-id paths.
They also verify normal init promotion and a competing reply's successful
promotion without an extra running broadcast. The stopped/archived probes
restored running before the fix; the conditional write now preserves them.
