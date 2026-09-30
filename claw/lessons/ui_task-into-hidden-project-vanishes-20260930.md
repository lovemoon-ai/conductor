# Tasks created or moved into a hidden project vanished

## Symptom

A task disappeared from the web task list when it was created or moved into a hidden project. This happened with `conductor task create/resume --project <hidden>`, with a create from a cwd inside a hidden project, and with `task move`. The web pickers never offer hidden projects.

## Root cause

`POST /api/tasks` and `PUT /api/tasks/[taskId]/second-project` only checked project ownership. The SDK resolves projects with `includeHidden: true`, so the CLI could target hidden projects.

## Fix

- Move: `PUT /api/tasks/[taskId]/second-project` returns 409 "Project is hidden; unhide it before moving tasks into it". Moving is an explicit user choice. Moving a task back to its home project is still allowed.
- Create: `POST /api/tasks` still accepts hidden projects. A first version returned 409 here too, but that broke `conductor fire` in a hidden project's directory. Fire finds its project with `/api/projects/match-path`, which does not skip hidden projects, and then creates its task through this same route (SDK `createTask`). It also broke `conductor task create` run by AIs inside such tasks. Instead, `conductor task create` prints a stderr warning when the resolved project is hidden ("project X is hidden; the task will not show in the web task list until you unhide it"). Fire prints no warning.

The web also leaves collaboration projects out of the move menu. That is a UI choice with no data-visibility reason, because move targets are always the caller's own project rows. So that filter stays client-only.

## How to avoid

Every project-picker filter in the web UI is a candidate server rule. Check the create and move routes whenever a picker gains a filter. Before you add a server rule, list every non-UI caller of the route (fire, daemon, SDK, AI-run CLI) and check what each one expects.
