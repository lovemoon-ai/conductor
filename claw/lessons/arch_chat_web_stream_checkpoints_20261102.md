# Streaming deltas must not rewrite the whole runtime store

## Symptom

Every text delta cloned, serialized and fsynced the entire multi-chat state, delaying other streams and RPCs.

## Root cause

The progress path used the same durable transaction as lifecycle transitions.

## Fix

Serialize volatile text/event updates in memory. Persist the first streaming checkpoint and subsequent durable lifecycle transitions, including the final result. Read individual conversations and turns without cloning unrelated state.

## Validation and prevention

Send 300 deltas and verify the checkpoint stays unchanged while clients receive all ordered events; then verify the final text and event history are durable. Recover an unclean checkpoint as uncertain without replay.
