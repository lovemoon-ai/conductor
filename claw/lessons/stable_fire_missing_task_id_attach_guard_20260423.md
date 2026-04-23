# Symptom

- Manual `conductor fire` could start a backend session and even print a model reply, but all upstream persistence failed with noisy `404` / `500` errors.
- Typical logs included `Failed to persist task session binding ... Backend responded with 404` and repeated durable retry failures for `sdk_message`.
- The failure mode was confusing because it looked like an AI backend or provider problem even though the local runtime itself was healthy.

# Root Cause

- `conductor-fire` treats `CONDUCTOR_TASK_ID` as an instruction to attach to an existing task instead of creating a new one.
- That path trusted the env var blindly and never verified that the referenced task still existed in the backend.
- When the env var pointed at a stale or missing task id, the runtime still launched normally, but every later backend write targeted a non-existent task and failed downstream.

# Fix

- Added `getTask()` to `conductor-sdk` so the fire runtime can validate an existing task id before attaching.
- Changed `ensureTaskContext()` to fail fast when `CONDUCTOR_TASK_ID` points to a missing backend task, with an explicit remediation message.
- Added regression tests for both the happy path and the stale-task fail-fast path.

# How To Avoid Next Time

- Any env var or resume path that reattaches to existing backend state must validate that state before launching a long-lived runtime.
- Prefer a short, explicit failure at bootstrap over letting session startup succeed and deferring ownership or persistence errors until later.
- Add tests for stale attachment identifiers anywhere task/session ids can be injected from parent processes or shell environment.
