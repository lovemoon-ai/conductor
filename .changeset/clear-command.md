---
"@love-moon/ai-sdk": minor
"@love-moon/conductor-cli": minor
---

Support `/clear` in task chats. Fire detects a bare `/clear` message (like
`/compact`) and drops the AI's context instead of sending the text to the model.
Sessions advertise `capabilities.clear` and implement the new optional
`runClear()` on top of each backend's own native reset, so the backend process,
browser or RPC connection stays up:

- claude: native `/clear` slash command (the SDK's `conversation_reset` reports
  the new conversation id)
- codex app-server: `thread/start` on the live transport
- codex exec: drops the replayed history, which is the whole context for a
  stateless CLI
- copilot: `createSession()` on the same client; the old conversation is
  detached, not deleted
- kimi wire and legacy print: the CLI's built-in `/clear` (prompt mode opts out)
- opencode: `session.create` on the same `opencode serve`
- dsh: rotates onto a fresh wire session id and keeps the runtime subprocess
- chat-web: `newChat()` in the same browser and profile

Backends without the capability (external providers) fall back to closing the
session and continuing on a brand-new one. Either way the task's chat history is
kept and the task is rebound to the session the backend ends up on, so a later
restart resumes the cleared conversation rather than the old one. The codex
fresh-session bootstrap lock now covers that fallback too, and the kimi wire
transport drops configured `--continue`/`--resume`/`--session` flags (like kimi
print already did) so they cannot reattach a cleared session to the old
conversation. Two caveats: the configured `pre_prompt` is not re-sent to the
cleared session, and a chat-web task running with
`CONDUCTOR_AI_SDK_DISABLE_WORKER=1` can only clear natively — its fallback would
hit the browser profile lock, because in that mode the lock owner is fire itself.
