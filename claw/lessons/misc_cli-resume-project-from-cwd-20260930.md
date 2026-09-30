# CLI resume filed the task under the cwd project

## Symptom

`conductor task resume` created the task in the project that matched the shell's cwd (or `CONDUCTOR_PROJECT_ID`). The web files a resumed session under the project whose workspace contains the session's cwd, and falls back to the default project.

## Root cause

`handleResume` reused the generic `resolveProject(cwd/--project)` helper instead of the session's `project_id`, which only the sessions API knows.

## Fix

Without `--project`, the CLI now reads `GET /api/agents/<host>/sessions?backends=<backend>&limit=200` and uses the session's `project_id`. The route has no session-id filter, and 200 is its maximum page. When the session is listed without a `project_id`, the CLI uses the default project, as the web does. Sometimes the list is unavailable: an older daemon returns 409 and an offline daemon returns 404. Sometimes the session is not in the list. In those cases the CLI falls back to the old cwd/`CONDUCTOR_PROJECT_ID` resolution and prints a warning. It does not silently pick the default project. `--project` still overrides.

## How to avoid

When a CLI command mirrors a web flow, take its inputs from the same API data the web uses, not from the CLI's local context.
