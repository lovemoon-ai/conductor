# CLI resume filed the task under the cwd project

## Symptom

`conductor task resume` created the task in the project that matched the shell's cwd (or `CONDUCTOR_PROJECT_ID`). The web files a resumed session under the project whose workspace contains the session's cwd, and falls back to the default project.

## Root cause

`handleResume` reused the generic `resolveProject(cwd/--project)` helper instead of the session's `project_id`, which only the sessions API knows.

## Fix

Without `--project`, the CLI now reads `GET /api/agents/<host>/sessions?backends=<backend>` and uses the session's `project_id`. It falls back to the default project, as the web does. `--project` still overrides.

## How to avoid

When a CLI command mirrors a web flow, take its inputs from the same API data the web uses, not from the CLI's local context.
