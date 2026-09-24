---
"@love-moon/conductor-cli": minor
"@love-moon/ai-sdk": minor
---

New Terminal and Resume Session previews in the create-task dialog.

- `@love-moon/ai-sdk`: `listSessions` (claude, codex) returns `preview` with
  the first user message, the assistant reply to it, and the session's last
  message.
- The daemon passes the preview to `list_backend_sessions` as
  `first_user_message`, `first_reply`, `last_message` and `last_message_role`.
- A PTY task with no project path now starts its shell in `$HOME`. The
  terminal log stays in the dated workspace directory.
