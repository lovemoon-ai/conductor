# Runtime retention must include browser profiles

## Symptom

Closed tasks accumulated records, turns and complete Chromium profiles until the 256/4096 caps stopped all new work.

## Root cause

Close only marked a conversation; nothing reclaimed closed records or terminal history.

## Fix

Keep the most recent 32 closed chats for at most seven days, reclaim least recently closed chats under capacity pressure, and remove their turns and profile directories. Prune old terminal turns in batches while protecting recent results, unacknowledged uncertain turns and live operations. Sweep orphan profiles after restart.

## Validation and prevention

Seed actual 256/4096 limits, verify new work is accepted after reclamation, preserve active chats and recent deduplication results, and check profiles are deleted with their records.
