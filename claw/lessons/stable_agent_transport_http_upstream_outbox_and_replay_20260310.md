# stable: relying on websocket ACKs in agent transport caused message loss, duplication, and accidental task kills (2026-03-10)

## Symptoms
- Users will encounter several types of problems with different appearances and similar root causes:
- The reply has been generated locally, but the last one `sdk_message` has not been stably submitted to the server. In the chat, it looks like "the last sentence disappeared"
- `task_status_update` or `task_stop_ack` does not commit stably when the link is flapping, and the task final state and stop semantics are occasionally lost.
- After the agent reconnects, the downstream command may be delivered repeatedly, or it may have been executed locally but the server still thinks it is not confirmed.
- Eventually it will appear that the task is interrupted, misjudged by `recover_stale` as `killed`, or duplicate messages/repeated actions appear on the UI

## Root Cause
- The old implementation tied key upstream events too tightly to websocket ACK responses:
- `sdk_message`
- `task_status_update`
- `agent_command_ack`
- `task_stop_ack`
- These events lack a unified HTTP commit entry and stable idempotent keys, causing "server processed" and "client received confirmation" to be mixed in the same unstable link.
- The SDK does not have a durable upstream outbox locally. When HTTP or websocket fails temporarily, the event cannot be reissued after the process is restarted.
- Downstream commands do not have cursor-based replay/duplicate suppression. After reconnection, it is impossible to distinguish between "not received", "received but ACK lost" and "already executed locally".

## Fix
- Added `POST /api/agent/events` to the server, converging `sdk_message`, `task_status_update`, `agent_command_ack`, and `task_stop_ack` into unified commit logic.
- Introduced stable idempotent keys for `sdk_message` and `task_status_update`, added `task_status_events` persistence table, and repeated submissions are successfully processed idempotently.
- The SDK adds project-level durable outbox for key upstream events, which are persisted locally first and then HTTP commit; `pending` can be returned if the retry fails, and flushing continues in the background and next startup.
- Add delivery cursor to downstream commands, agent resume reports the last applied cursor; the server presses cursor replay, and SDK suppresses repeated commands.
- Delete the websocket-confirmable ACK-of-ACK compatibility layer, which has no business value and only amplifies a single missed ACK into a fatal failure.

## Prevention
- Four things must be clarified first when designing key events: submission channels, idempotent keys, local persistence, and reconnection replay; you cannot first connect to the real-time link and then improve reliability.
- "Last message" "Last final state" "stop ack" "Replay after reconnection" must be done separately for stability testing, and cannot only cover the normal online path.
- When the protocol evolves, upstream commit and downstream replay should be regarded as a set of semantic designs to avoid being durable while still relying on stateless websocket to fill holes.

## Related Documents
- Phase 1: [agent-http-upstream-phase1-20260310.md](/Users/duino/ws/conductor/claw/issues/done/agent-http-upstream-phase1-20260310.md)
- Phase 2: [agent-http-upstream-durable-outbox-20260310.md](/Users/duino/ws/conductor/claw/issues/done/agent-http-upstream-durable-outbox-20260310.md)
- Phase 3: [agent-downstream-replay-and-stop-ack-20260310.md](/Users/duino/ws/conductor/claw/issues/done/agent-downstream-replay-and-stop-ack-20260310.md)
- Diagnosis: [stable_4090_four_killed_tasks_20260310.md](/Users/duino/ws/conductor/claw/issues/stable_4090_four_killed_tasks_20260310.md)
