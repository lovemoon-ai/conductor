---
"@love-moon/chat-web": patch
"@love-moon/ai-sdk": patch
"@love-moon/conductor-cli": patch
---

Add Kimi website text conversations with persistent login, multi-turn context,
reply progress, new chats and browser diagnostics. Expose the provider through
ai-sdk's chat-web backend and the web-kimi Conductor configuration alias.

Explicit unknown chat-web providers now fail with a clear error instead of
silently opening ChatGPT. The existing kimi CLI backend is unchanged.
