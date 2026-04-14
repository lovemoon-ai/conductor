# ui: runtime details fields overwritten by partial status packets (2026-04-14)

## Symptoms
- On the Task page, the `Runtime Details` popover could initially show valid values such as daemon, PID, backend, and session ID.
- While the task was still running, some of those fields would later flip to `n/a` even though the underlying task execution had not actually lost that metadata.

## Root Cause
- The frontend runtime store treated each `task_runtime_status` event as a full snapshot.
- In practice, later runtime packets often only carried progress fields like `state`, `phase`, `status_line`, or `reply_preview`, and did not repeat stable metadata such as `daemon`, `pid`, `backend`, or `session_id`.
- The store replaced the whole task runtime record with the sparse packet, so previously known stable fields were dropped.
- `ConnectionStatus` then rendered those missing fields as `n/a`.

## Fix
- Changed the runtime store to merge incoming runtime packets with the existing task runtime record instead of overwriting it wholesale.
- Preserved stable runtime fields across sparse progress updates, including daemon, PID, backend, session ID, session file path, and usage percentages.
- Added `ConnectionStatus` fallback logic so backend and session ID can still render from persisted task fields when the runtime packet does not include them.
- Added regression tests for partial runtime status updates and popover fallback rendering.

## Prevention
- Treat streaming runtime status events as partial updates unless the protocol explicitly guarantees full snapshots.
- For user-facing diagnostics panels, prefer retaining the last known good stable metadata over dropping to `n/a` on sparse updates.
- Add a regression test whenever a realtime payload is consumed as UI state and some fields are optional or event-dependent.
