---
"@love-moon/chat-web": patch
"@love-moon/ai-sdk": patch
---

Preserve lightweight conversation identity archives across profile/history GC so
Conductor can resume the same provider conversation using its existing local ID.
Archive idle, workerless open chats; persist the completed-turn resume guard; and
distinguish slow page loading from confirmed authentication failures.

Upgrading a CLI while an older managed runtime is running can report
RUNTIME_UPGRADE_REQUIRED when queuedStartup or durableResume support is missing.
After active chats finish, run `conductor chat-web runtime stop` and retry;
the next managed session starts the updated runtime. Alternatively, a runtime
with no active turns or pinned login windows exits after ten minutes without
requests. The CLI never terminates running chats automatically.

Profile deletion now starts only after the retention checkpoint commits, and
closed chats awaiting uncertainty review retain their profiles and turn history.
Accepted prompts refresh idle activity before collection, keeping their parent
conversation resident even when a client submits directly after a long idle.
