---
"@love-moon/conductor-cli": minor
"@love-moon/conductor-sdk": minor
"@love-moon/ai-sdk": minor
---

Show each AI reply's token usage beside its timestamp: the turn's tokens, the
task total after it, and the input cache share (the part of the turn's input
served from the prompt cache).

- `@love-moon/ai-sdk`: new `summarizeTurnUsage(usage)` normalizes a turn's usage
  into `{ tokens, inputTokens, cachedInputTokens }` (Claude: fresh input + cache
  writes + cache reads; Codex: input already includes cached). The Codex
  app-server provider's turn/goal `usage` now also carries `turnInputTokens` and
  `turnCachedInputTokens`.
- `@love-moon/conductor-sdk`: `sendTurnUsage` accepts `input_tokens`,
  `cached_input_tokens` and the reply's `message_id`.
- `conductor fire` reports a finished turn's usage after its reply, naming that
  reply (for streamed sessions, the turn's last streamed reply), so the server
  records it on the message (`metadata.turn_usage`) and pushes it to open chats.
