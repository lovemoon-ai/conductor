# Tasks created or moved into a hidden project vanished

## Symptom

A task disappeared from the web task list when it was created or moved into a hidden project. This happened with `conductor task create/resume --project <hidden>`, with a create from a cwd inside a hidden project, and with `task move`. The web pickers never offer hidden projects.

## Root cause

`POST /api/tasks` and `PUT /api/tasks/[taskId]/second-project` only checked project ownership. The SDK resolves projects with `includeHidden: true`, so the CLI could target hidden projects.

## Fix

Both routes now return 409 "Project is hidden; unhide it before ..." when the target project has `hiddenAt`. Moving a task back to its home project is still allowed. Internal task creators (issues, rounds, restart, fire) do not go through these routes.

The web also leaves collaboration projects out of the move menu. That is a UI choice with no data-visibility reason, because move targets are always the caller's own project rows. So that filter stays client-only.

## How to avoid

Every project-picker filter in the web UI is a candidate server rule. Check the create and move routes whenever a picker gains a filter.
