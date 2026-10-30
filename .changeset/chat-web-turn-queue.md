---
"@love-moon/chat-web": patch
"@love-moon/ai-sdk": patch
---

Add QueuedChatSession with a shared local browser broker and a FIFO turn queue
across processes. Each task retains its own conversation tab; idle tasks no
longer hold exclusive access to the provider profile. The AI SDK uses queued
sessions when available and reports waiting positions through working status.

Cancel pending turns on disconnect, stop/close failed conversation tabs before
advancing the queue, and release the browser after its last client exits.
Keep the exclusive ChatSession API available for direct Playwright access.

Keep logical sessions usable after an active stop, timeout, or provider failure.
Restore the original provider conversation for the next explicit user operation;
require explicit clear when safe restoration is unavailable, and never replay a
failed prompt. Allow clear after a failed first submission. Correct the Windows
named-pipe address escaping.
