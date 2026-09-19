---
"@love-moon/ai-sdk": patch
"@love-moon/conductor-cli": patch
---

Support `/compact [focus instructions]` in task chats. Fire detects the command
per message (like `/goal`), runs the backend's native context compaction
instead of sending the text to the model, and posts one confirmation with the
token savings. Sessions advertise `capabilities.compact` and implement the new
optional `runCompact()`: claude (native `/compact`), codex app-server
(`thread/compact/start`), copilot (`session.history.compact`), kimi wire and
legacy print (built-in `/compact`), opencode (`session.summarize`) and dsh
(summary turn, then a fresh session seeded with the summary). Backends without
the capability (chat-web, codex exec, Kimi Code prompt mode) reply with a
not-supported notice. Opencode compaction summaries no longer surface as chat
replies, and dsh clears its "compacting context" status when automatic
compaction ends.
