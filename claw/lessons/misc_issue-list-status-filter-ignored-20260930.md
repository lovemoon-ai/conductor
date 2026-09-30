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
SDK and `--all-projects/--project-ids` pass the list through; CLI help and
choices use `todo|doing|done`.

## How to avoid next time
When a client sends a query param, have a route test proving the server honors
it; don't let a client-side filter hide a server that ignores it.
