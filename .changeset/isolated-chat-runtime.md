---
"@love-moon/chat-web": minor
"@love-moon/ai-sdk": minor
"@love-moon/conductor-cli": minor
---

Add a local multi-chat runtime with isolated Chromium workers, persistent profiles,
per-account concurrency, resumable events, request deduplication, and SDK/CLI access.
Add experimental Kimi and Claude webpage adapters and optional AI SDK socket transport.

Support Kimi Connect JSON envelopes and DeepSeek XHR SSE patches, with verified
parallel real-account text chats, independent cancellation, and restart recovery.

Add DeepSeek --deepthink / --no-deepthink controls and SDK options with persisted
chat defaults, per-turn overrides, verified UI state, and runtime capability checks.

Connect Conductor web-kimi and web-deepseek to managed isolated Chromium workers
by default. Add conductor chat-web login, account credential bootstrap, automatic
daemon startup and idle shutdown, stable cross-process resume IDs, and browser
release when tasks close. Preserve the shared-profile queue for other providers.
Retain cancelled conversation URLs and report confirmed stops as interruptions.
