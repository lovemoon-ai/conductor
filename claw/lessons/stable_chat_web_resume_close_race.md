# Closing a chat can race a headed browser resume

## Symptom

A close could remove a worker while a headed resume awaited worker.open().
When opening settled, resume tried to pin a missing worker and threw TypeError.

## Root cause

Resume assumed its worker entry survived across an asynchronous open.

## Fix

After opening, check whether the conversation is closing or closed and whether
the same worker is still owned. Return CHAT_CLOSED rather than pinning a removed
or replaced worker. Close can still interrupt active work.

## Validation and prevention

Hold a fake browser open, close its chat, then settle open. The caller receives
CHAT_CLOSED, no worker remains pinned, and an explicit later resume succeeds.
