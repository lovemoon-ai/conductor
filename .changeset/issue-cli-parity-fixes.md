---
"@love-moon/conductor-cli": minor
"@love-moon/conductor-sdk": patch
---

`conductor issue` now matches the web issue board:
`start --daemon <host> [--project <id>]` picks the daemon, or the merged-group
sibling project, that the task runs on. `--priority` takes `P0|P1|P2`, and
`--status` uses `todo|doing|done`; `create` no longer offers `doing`. `list --status`
is filtered by the server. An invalid argument now exits 2 without sending a
request. The SDK's `updateIssue` forwards `projectId`, and `listIssues` sends
multiple statuses to the server.

The matching web server changes (metadata patches merge instead of replacing,
`GET /api/issues?status=` filtering) should be deployed before publishing.
