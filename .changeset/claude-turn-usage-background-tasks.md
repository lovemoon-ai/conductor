---
"@love-moon/ai-sdk": patch
"@love-moon/conductor-cli": patch
---

Claude turns that wait on background subagents now report their full token
usage. Such a turn emits one result per segment and the task card used to show
only the last segment; it now sums the result's `modelUsage`, which covers
every segment and every subagent.
