---
"@love-moon/ai-sdk": patch
"@love-moon/conductor-cli": patch
---

Codex turns that spawn sub-agents now include the sub-agents' tokens in the
turn usage. Their `thread/tokenUsage/updated` notifications carry the
sub-agent's own thread id and were dropped with its other events. A
sub-agent's replayed total is not counted, and whatever it spends after the
parent turn ends goes to the next turn.
