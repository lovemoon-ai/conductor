# Attachment message lost before AI answer

## Symptom

An attachment message could be acknowledged and displayed in Web, but never receive an AI answer after Fire or the Daemon restarted.

## Root cause

The durable downstream inbox was completed when the message entered an in-memory session queue, before AI execution and answer persistence. A shutdown race also removed an already-acknowledged command without routing it.

## Fix

Shutdown now preserves an attachment command that finishes downloading during close, so it can be replayed. Extending durability through AI execution requires a separate processing journal and stable answer idempotency key; an in-memory answer waiter is explicitly insufficient.

## Prevention

Define delivery completion at the final durable boundary, not at an intermediate in-memory handoff. Test crashes before routing, during execution, and before answer commit.
