# Backend silently dropped attachments

## Symptom

Codex goal mode and Chat Web could accept a message while silently omitting its image or context file. Attachment-only API messages could also be skipped by Fire.

## Root cause

Fire treated empty text as an empty turn, Codex goal did not consume turn attachment options, and Chat Web ignored an unsupported `contextFiles` option.

## Fix

Attachment-only turns receive a default prompt. Goal messages with attachments use `runTurn`, and Chat Web explicitly rejects context files.

## Prevention

Every provider entry point must either consume each input capability or return a typed unsupported error. Include provider-level tests for attachment-only, goal, and unsupported inputs.
