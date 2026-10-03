---
"@love-moon/ai-sdk": patch
---

Kimi Code tasks no longer kill background subagents after 12 minutes. `kimi -p`
stays silent while it waits for a task it launched with `run_in_background`,
and the session's idle deadline used to treat that silence as a stuck turn and
terminate kimi together with the task. Once a turn launches a background task,
the deadline now waits for kimi to exit on its own.
