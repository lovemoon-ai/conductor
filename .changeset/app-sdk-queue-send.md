---
"@love-moon/app-sdk": patch
---

`<ChatView />` keeps the send button available while a reply is in progress, so
follow-up messages queue after the current turn like in the main app. The
interrupt button is shown next to it instead of replacing it.
