# The resume guard must survive turn-history pruning

## Symptom

A completed chat without a saved URL could silently start a fresh provider conversation after its completed turns were collected.

## Root cause

The resume guard inferred prior completion by scanning retained turns.

## Fix

Persist hasCompletedTurn on the conversation, migrate it before retention runs, and include it in identity archives. Worker eviction and acquisition use this durable flag independently of turn history.

## Validation and prevention

Prune eight-day-old completed history and profiles for both open and closed URL-less chats, then verify resume raises RESUME_UNSUPPORTED before opening a browser.
