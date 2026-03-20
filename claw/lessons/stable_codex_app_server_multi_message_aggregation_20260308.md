# stable: postmortem of multiple assistant replies being incorrectly aggregated in Codex app-server (2026-03-08)

## Symptoms
- When users perform long-term or staged tasks in Codex tasks, Codex may generate multiple assistant replies in the same turn.
- For example:
  - `Start a 2-minute timer.`
  
  - `Done`
- But the frontend actually only received one combined message, resulting in the intermediate stage reply and the final reply being mixed together, resulting in semantic errors.

## Root Cause
- The old implementation put the message aggregation logic in `fire` in order to stop the chunk of `codex-app-server` from flushing the screen first.
- `fire` can only see `replyTo`, not the real boundary of the Codex assistant item.
- The result is:
  - Streaming chunks within the same assistant message will be merged correctly
- But multiple assistant messages in the same turn will also be merged incorrectly

## Fix
- Recover the Codex assistant message aggregation logic from `modules/ai-sdk` to `codex-app-server-session`.
- The provider identifies a complete assistant message based on `item/started`, `item/agentMessage/delta`, `item/completed` and assistant `itemId`.
- Only after an assistant message is completely completed can a message be emitted to `fire`.
- `fire` deletes the Codex exclusive aggregation logic and only retains session stream message forwarding.
## Prevention
- The message boundary inside the provider cannot be raised to the controller / fire layer for processing.
- If you want to "stop-the-bleeding" aggregation repair, you must also ensure that the semantic boundaries come from the provider, rather than guessed by `fire` based on turn or replyTo.
- For `app-server` structured protocols, tests must cover:
  - Streaming chunk merging of single reply
- Multiple assistant replies within the same turn are separated