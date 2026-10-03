---
"@love-moon/ai-sdk": patch
---

Claude tasks keep one Claude process per session, with its input left open
between turns, instead of starting a new one-shot process for every turn.
Background subagents now run to completion: before, claude killed them 10
minutes after the main agent's turn ended, so long multi-agent tasks went quiet
until the user sent another message. When they finish, Claude's follow-up reply
is posted to the chat without waiting for a user message. Subagent narration is
no longer posted as a task reply.
