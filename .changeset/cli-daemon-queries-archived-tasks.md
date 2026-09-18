---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": patch
---

Add read-only daemon queries and archived-task search to the CLI:
`conductor daemon list [--all]` (online daemons, version, AI backends),
`conductor daemon tools <host>` (installed AI tools and reachability),
`conductor daemon quota <host> [--tool] [--refresh]` (usage windows / balance
per tool), and `conductor task list --archived [--search] [--all-projects]
[--page]`. The SDK's `BackendApiClient` gains `listAgents`,
`getAiManagerStatus`, `getAiManagerQuota` and `listAchievedTasks` over the
existing web API routes; no server change.
