---
"@love-moon/ai-sdk": patch
"@love-moon/conductor-cli": patch
---

Claude turns that wait on background subagents now report their full token
usage. Such a turn emits one result per segment and the task card used to show
only the last segment; it now sums the result's `modelUsage`, which covers
every segment, every subagent and small side calls. `conductor serve-ai`'s
`prompt_tokens` / `completion_tokens` come from the same usage, so they now
include those too. A turn cut off after an earlier segment keeps that
segment's usage.
