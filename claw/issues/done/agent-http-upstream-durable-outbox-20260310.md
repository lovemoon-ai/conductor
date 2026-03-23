# Issue: agent upstream durable outbox phase 2

## Problem / Context

Phase 1 has switched key upstream events to HTTP commit, but the SDK still lacks a local durable outbox:

- `sendMessage()` / `sendTaskStatus()` / `sendAgentCommandAck()` There is no real local persistence retry when HTTP temporarily fails.
- If the fire process exits before HTTP commit, the current slice cannot be reissued at the next startup.
- This will still leave the "local reply was generated, but disappeared after the remote commit failed" tail window

## Goal

Add project-level durable upstream outbox to `modules/conductor-sdk` so that these three types of HTTP upstream events have:

- Persist locally first
- Try HTTP commit again
- Background retry in case of temporary failure
- Automatically flush unfinished events after the next process starts

## Acceptance Criteria

- [x] Added project-level durable outbox store, which defaults to `<project>/.conductor/state/agent-upstream-outbox.json`
- [x] `sendMessage()` no longer throws an error to interrupt the main process under retryable HTTP failure, but returns `pending`
- [x] `sendTaskStatus()` / `sendAgentCommandAck()` have the same semantics
- [x] `ConductorClient.connect()` will automatically flush local pending upstream events
- [x] Add store test and client retry/recovery test

## Scope

- In scope
- Local persistence on SDK side-retryable/terminal error classification
- startup flush

- Out of scope
- `task_stop_ack` durable
- Server downlink replay
- local sqlite store

## Plan / Tasks

- [x] Added `modules/conductor-sdk/src/outbox/store.ts`
- [x] Added `modules/conductor-sdk/src/outbox/index.ts`
- [x] Adjust the three types of HTTP upstream paths for `modules/conductor-sdk/src/client.ts`
- [x] Added `modules/conductor-sdk/tests/outbox_store.test.ts`
- [x] extension `modules/conductor-sdk/tests/conductor_client.test.ts`

## Risks / Dependencies

- Need to ensure that the store file does not conflict with the user's existing workspace file
- Need to avoid retry timer leaking when close
- It is necessary to clarify which HTTP errors can be retried and which ones must fail immediately

## Links

- Phase 1: [agent-http-upstream-phase1-20260310.md](/Users/duino/ws/conductor/claw/issues/done/agent-http-upstream-phase1-20260310.md)
- RFC: [0005-feature-agent-transport-split-http-upstream-websocket-downstream.md](/Users/duino/ws/conductor/claw/rfc/0005-feature-agent-transport-split-http-upstream-websocket-downstream.md)
