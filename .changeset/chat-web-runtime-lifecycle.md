---
"@love-moon/chat-web": patch
"@love-moon/ai-sdk": patch
"@love-moon/conductor-cli": patch
---

Bound closed-chat and terminal-turn retention, reclaim browser profiles and orphan
directories, and keep streaming deltas in memory between durable checkpoints.
Defer saturated or busy chat startup to the turn queue, validate authentication at
allocation, and expire queued prompts before crash recovery or delayed submission.
Keep Gemini on its legacy transport with global runtime sockets and consume the
Conductor wrapper separator before forwarding a packaged CLI command.
