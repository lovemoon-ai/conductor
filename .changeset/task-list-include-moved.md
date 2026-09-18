---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": patch
---

`conductor task list --include-moved` also lists tasks moved into the project
from other projects (`project_id == P OR second_project_id == P`), with a MOVED
column naming the origin/target project. `--json` output now carries
`secondProjectId`. The SDK gains `TasksApi.listTasks({ includeMoved })`,
`BackendApiClient.listTasks({ projectScope: 'display' })` and
`Task/TaskSummary.secondProjectId`; it merges the server's existing real and
display scopes, so no server change is needed.
