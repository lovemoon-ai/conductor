---
"@love-moon/ai-sdk": patch
---

Fix Codex tasks that stopped mid-reply after the agent spawned sub-agents. In
multi-agent mode the Codex app-server also streams the sub-agent threads, and
the first sub-agent to finish ended the parent turn. The parent's later
messages and final answer were dropped, and a sub-agent's report could show up
as the AI reply. The session now ignores notifications from other threads.
