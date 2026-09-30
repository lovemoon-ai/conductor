# Issue: `conductor issue list --status` returned wrong results

## Symptom
`issue list --status doing` listed every issue; `--status backlog` (the CLI's
own example) matched nothing.

## Root cause
`GET /api/issues` ignored `status`. The SDK sent a single status to the server
and only filtered client-side for two or more, and the CLI advertised
`backlog`, which the server serializes as `todo`.

## Fix
The route validates a comma-separated `status` with Zod, maps legacy aliases
(`backlog`→`todo`, `review`→`doing`) and filters the stored values in SQL. The
SDK and `--all-projects/--project-ids` pass the list through and, since an older
server ignores it, filter the result again with the same alias map; CLI help
and choices use `todo|doing|done`.

## How to avoid next time
When a client sends a query param, have a route test proving the server honors
it, and a client test against a server that ignores it: a new CLI/SDK still
talks to old servers.
