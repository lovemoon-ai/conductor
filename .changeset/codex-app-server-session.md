---
"@love-moon/ai-sdk": minor
---

Add the `codex-app-server-session` provider, recover Codex oversized threads by
rolling onto a fresh provider thread with bounded recent history (one retry per
turn), and trim the dsh quota raw payload.
