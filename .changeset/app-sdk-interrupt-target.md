---
"@love-moon/app-sdk": patch
---

Fix `<ChatView />` interrupts being rejected by the fire owner: when runtime
status has no `replyTo`, target the user message being answered (the reply's
`reply_to`, or the message just sent) instead of the assistant reply's own id.
