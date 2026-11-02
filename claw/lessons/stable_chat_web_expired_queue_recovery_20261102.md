# Expired queued prompts must not execute after a crash

## Symptom

A queued prompt could execute after the original client had already reported a failure.

## Root cause

Recovery rescheduled every queued turn without checking how long it had waited.

## Fix

Cancel queued turns whose creation time plus timeout has expired during startup. Check the same deadline immediately before allocation; persist QUEUE_EXPIRED and preserve deduplication. Never replay previously submitted turns.

## Validation and prevention

Recover a checkpoint containing expired queued, recent queued and interrupted turns. Only recent queued work sends; verify expiry before a live queue hands off its next worker.
