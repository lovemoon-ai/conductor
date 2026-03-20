# Issue: agent upstream HTTP commit phase 1

## Problem / Context

`conductor-fire -> backend`'s key upstream events currently still rely heavily on websocket ACK return:

- `sdk_message`
- `agent_command_ack`
- `task_status_update`
This will tie "task execution correctness" to whether websocket is currently stable. This has appeared many times online:

- The local reply has been generated, but the last one `sdk_message` has not been stably dropped into the database.
- ACK return jitter is amplified into task interruption or subsequent stale kill
- `task_status_update` does not have a stable idempotent key, and the final state synchronization semantics is unclear.
## Goal

The first publishable slice of transport-split:

- The key upstream event is changed to HTTP commit
- websocket temporarily retains the downstream and compatible entrances
- The server converges to a single commit logic, shared by HTTP / websocket
- SDK no longer waits for `message_recorded` / `agent_command_ack_recorded`

## Acceptance Criteria

- [x] `sdk_message` is submitted through `POST /api/agent/events`, and `message_id` is idempotent.
- [x] `task_status_update` is submitted via `POST /api/agent/events` and updated idempotently by `status_event_id`
- [x] `agent_command_ack` is submitted through `POST /api/agent/events`. Repeated submissions still return success.
- [x] `sdk_message` / `task_status_update` / `agent_command_ack` of websocket gateway reuse the same commit service
- [x] `modules/conductor-sdk`'s `sendMessage()` / `sendTaskStatus()` / `sendAgentCommandAck()` changed to HTTP
- [x] Add at least 1 web route test and 1 set of SDK tests to cover idempotence and new calling paths

## Scope

- In scope
- Added agent HTTP upstream route
- Added server-side shared commit service
- Added `task_status_events` persistence table
- SDK switches among the first batch of three types of key upward events
- Keep websocket ACK compatible and will not be deleted in this batch

- Out of scope
- Local durable journal / outbox
- `task_stop_ack` HTTPization
-Download command `seq` / cursor / replay
- Remove websocket `message_recorded` / `agent_command_ack_recorded`

## Plan / Tasks

- [x] Added `task_status_events` schema and migration
- [x] Added `web/src/lib/realtime/agent-upstream.ts`
- [x] Added `web/src/app/api/agent/events/route.ts`
- [x] Let `web/src/lib/realtime/agent-gateway.ts` reuse shared commit service
- [x] Extend `modules/conductor-sdk/src/backend/client.ts`'s agent event commit API
- [x] Adjust `modules/conductor-sdk/src/client.ts`'s three upstream methods to HTTP
- [x] Update `modules/conductor-sdk/tests/*`
- [x] Added `web/src/app/api/agent/events/route.test.ts`

## Risks / Dependencies

- Prisma client needs to be regenerated after the schema is changed.
- This batch has not introduced local durable outbox, so the window where the fire process crashes directly before HTTP commit still exists
- Duplicate code paths will be temporarily retained during the transition period between websocket and HTTP dual stacks, and will need to be cleaned up separately in the future.

## Links

- RFC: [feature-agent-transport-split-http-upstream-websocket-downstream.md](/Users/duino/ws/conductor/claw/rfc/feature-agent-transport-split-http-upstream-websocket-downstream.md)
- Related diagnosis: [stable_4090_four_killed_tasks_20260310.md](/Users/duino/ws/conductor/claw/issues/stable_4090_four_killed_tasks_20260310.md)
