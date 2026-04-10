# UI: Task detail back navigation lost project scope

- Symptom: From a task message/detail page, using the back button returned to `/app/tasks`, which showed all tasks instead of the current project's task list.
- Root cause: The detail page back handler used a hard-coded `/app/tasks` route and did not preserve the task's `projectId` or the selected project.
- Fix: Build the back target from the loaded task's `projectId`, falling back to the selected project id, and navigate to `/app/tasks?projectId=...` when available.
- Prevention: Project-scoped task navigation should derive list URLs from task/project context instead of hard-coding the global task list route.
