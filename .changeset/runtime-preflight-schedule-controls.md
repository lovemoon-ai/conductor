---
"@love-moon/conductor-cli": minor
"@love-moon/conductor-sdk": minor
---

Runtime health preflight and agent schedule access control. The daemon now
advertises positive backend runtime health (`x-conductor-runtime-health`) so the
backend can reject task creation with `503 runtime_unavailable` before any
timeline activity, and adds `disable_built_in_cli_list` to opt out of built-in
SDK backends. The SDK attributes agent-originated scheduled-message calls with
`X-Conductor-Actor: agent` so per-task `agent_schedule_access`
(full/read_only/blocked) can govern `conductor task schedule` from agents while
human/UI calls stay unrestricted.
