---
"@love-moon/conductor-cli": minor
---

Support `/clear` in task chats. Fire detects a bare `/clear` message (like
`/compact`), closes the backend session and continues on a brand-new one, so
the AI starts with an empty context while the task's chat history is kept. The
new session is announced and, once it has an id, bound to the task, so a later
restart resumes it rather than the old one. Works for every backend.
