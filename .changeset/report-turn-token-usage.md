---
"@love-moon/conductor-cli": minor
"@love-moon/conductor-sdk": minor
"@love-moon/ai-sdk": minor
---

Report how many model tokens each turn consumed. After every turn (or `/goal`)
`conductor fire` sends the turn's token count (fresh input + cache reads/writes +
output) over the new `task_turn_usage` websocket event, and the server adds it
to the task's running total shown in the task detail card.

Failed or interrupted turns and `/compact` are counted too; when a turn's usage
is unknown the fire reports `null`, which clears the task's last-turn count.

- `@love-moon/conductor-sdk`: new `ConductorClient.sendTurnUsage(taskId, { tokens })`.
- `@love-moon/ai-sdk`: the Codex app-server provider's turn/goal `usage` now
  carries `turnTotalTokens`, the turn's share of Codex's thread-cumulative total.
  Claude and Codex turn errors carry the tokens spent before the failure as
  `error.usage` (Claude sums streamed usage when an interrupted query ends
  without a result).
- Claude and Codex backends are counted; other backends report nothing yet.
