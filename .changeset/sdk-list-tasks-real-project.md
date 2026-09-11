---
"@love-moon/conductor-sdk": patch
---

`listTasks({ projectId })` now lists a project's tasks by their real project.

Tasks can now be moved (filed) under any project in the web UI. That move is
display-only, and `GET /api/tasks?project_id=` keeps grouping by where a task is
filed for user-facing clients. The SDK now sends `project_scope=real`, so an
agent's `list_tasks` still sees every task that actually belongs to the project
(including ones the user filed elsewhere) and does not pick up tasks filed into
it from other projects.
