# Busy browser pools must defer startup to the turn queue

## Symptom

The fifth Conductor session failed before it could queue; a reconnect during an active turn also failed boot.

## Root cause

Login preflight unconditionally resumed a browser, acquiring a slot before turn scheduling.

## Fix

Add opt-in deferred resume and SDK prepare. Busy chats and saturated pools return queued readiness; the worker verifies authentication once allocated. Reopen a closed chat without needing a free browser. Older managed daemons require an explicit restart.

## Validation and prevention

Run six SDK sessions through two workers, reconnect during an active turn without replay, and reject deferred unauthenticated work before sending.
