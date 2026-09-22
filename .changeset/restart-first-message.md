---
"@love-moon/conductor-cli": patch
---

"New task from this" can start the new task with a first message you write
yourself. When one is set, the daemon sends it to the successor AI instead of
the default prompt that loads the source task's conversation as background. The
daemon advertises this as the `restart_first_message` capability; for older
daemons the dialog locks the field (the new task still starts with the default
background) and the server rejects a custom first message.
