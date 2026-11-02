---
"@love-moon/chat-web": patch
"@love-moon/ai-sdk": patch
---

Preserve lightweight conversation identity archives across profile/history GC so
Conductor can resume the same provider conversation using its existing local ID.
Archive idle, workerless open chats; persist the completed-turn resume guard; and
distinguish slow page loading from confirmed authentication failures.
