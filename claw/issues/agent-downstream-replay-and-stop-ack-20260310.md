# Issue: agent downstream replay cursor and durable task_stop_ack

## Problem / Context

Phase 2 has solved the durable HTTP commit of upstream `sdk_message` / `task_status_update` / `agent_command_ack`, but there are still three tail problems:

- `task_stop_ack` still uses websocket, and after the stop callback has been executed, it may still be lost due to connection jitter.
- `server -> agent` is still just outbox + realtime send, without agent cursor, and it is impossible to distinguish between "not received" and "locally applied but ACK lost" when reconnecting.
- The old websocket confirmable / `message_recorded` / `agent_command_ack_recorded` compatibility layer in the SDK is no longer called, but the code is still retained

## Goal

- `task_stop_ack` incorporated into HTTP durable upstream
-Downline commands support cursor-based replay and duplicate suppression
- Removed old websocket ACK-of
- ACK compatibility layer

## Acceptance Criteria

- [x] `sendTaskStopAck()` is changed to durable HTTP commit,retryable failure and returns `pending`
- [x] `agent_resume` can carry the last applied downstream cursor
- [x] The server will first press the cursor to add ACK, and then replay the latest outbox command.
- [x] SDK no longer applies replay `task_user_message` / `task_action` / `stop_task`
- [x] Delete unused websocket confirmable / `message_recorded` / `agent_command_ack_recorded` dependencies in SDK
- [x] Add web route / outbox test and SDK replay test

## Scope

- In scope
- `task_stop_ack` HTTP upstream
- downstream cursor store
- agent resume replay
- duplicate suppression
- Remove old ACK compatibility

- Out of scope
- Complete isomorphic transformation of daemon raw websocket client
- agent_outbox creates a new seq table or reconstructs the entire schema
- replay in browser/app websocket direction

## Plan / Tasks

- [x] Extended `/api/agent/events` support `task_stop_ack`
- [x] Add downstream cursor store for `modules/conductor-sdk`
- [x] Implement cursor reconcile + replay filtering on `agent_outbox`
- [x] Clean up SDK old websocket confirmable code
- [x] Fix web and SDK tests

## Risks / Dependencies

- The cursor adopts the `(createdAt, requestId)` order, and it is necessary to ensure that the server replay is executed in the same order.
- The first time the websocket reconnects to `agent_resume` and reported to the cursor, duplicate commands may still be received. The SDK requires local deduplication.
- Needs compatibility with daemons that still use the old websocket `task_stop_ack`

## Links

- Phase 1: [agent-http-upstream-phase1
- 20260310.md](/Users/duino/ws/conductor/claw/issues/agent-http-upstream-phase1
- 20260310.md)
- Phase 2: [agent-http-upstream-durable-outbox
- 20260310.md](/Users/duino/ws/conductor/claw/issues/agent-http-upstream-durable-outbox
- 20260310.md)
- RFC: [0005-feature-agent-transport-split-http-upstream-websocket-downstream.md](/Users/duino/ws/conductor/claw/rfc/0005-feature-agent-transport-split-http-upstream-websocket-downstream.md)
