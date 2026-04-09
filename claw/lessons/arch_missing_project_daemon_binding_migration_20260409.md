# Missing Prisma migration for Project daemon binding

## Symptom

During the 0.2.33 release, the deploy to volc prod was blocked because the refactor branch `feat/refactor_projeect` had edited `web/prisma/schema.prisma` and `web/prisma/schema.postgres.prisma` to introduce:

- New columns on `Project`: `daemon_host`, `workspace_path`, `repo_root`, `worktree_branch`, `last_commit`, `file_count`
- New `DefaultProject` model (table `default_projects`) with FKs to `users` and `projects`
- New indexes and unique constraints on `projects`
- Dropped the old `UNIQUE (user_id, name)` constraint in favor of `UNIQUE (user_id, daemon_host, name)`

…but **no corresponding migration file** was committed under `web/prisma/migrations/`. The last committed migration was still `20260402101500_shared_tasks`.

If the release had been deployed without noticing, the first API request that touched `projects.daemon_host` or `default_projects` would have crashed in prod.

## Root cause

Someone used `prisma db push` (or a similar non-migration workflow) to evolve their local `web/prisma/dev.db` while developing the project/daemon binding feature. `prisma db push` rewrites the database schema directly to match `schema.prisma` without creating a migration file. The TypeScript code and the local DB stayed consistent, so tests passed, but the migrations directory was left behind.

The same mistake had been made at least twice before — the migrations directory was also drifting from `schema.prisma` for the `users` table (invite fields) and the `agent_outbox` table (DLQ fields). Those earlier drifts were papered over by running `db push` directly on prod at some point, leaving the `_prisma_migrations` table and the live schema in sync with each other but both out of sync with the repo.

## Fix

Hand-wrote a new migration file at `web/prisma/migrations/20260409120000_add_project_daemon_binding/migration.sql` containing **only** the delta for this release:

- `DROP INDEX projects_user_id_name_key`
- Six `ALTER TABLE projects ADD COLUMN ...`
- `CREATE TABLE default_projects` (+ two unique indexes, two FKs)
- Five new indexes / unique indexes on `projects`

Why hand-written instead of `prisma migrate dev`? Because `prisma migrate diff --from-migrations --to-schema-datamodel` would have also emitted `RedefineTables` blocks for the historically drifted `users` and `agent_outbox` tables. Those blocks do `CREATE TABLE new_users ... INSERT ... SELECT (15 columns) FROM users` using the migrations directory's view of `users` (15 columns), even though prod's real `users` table has 19 columns. Running that auto-generated SQL against prod would have **silently dropped `invite_code`, `invited_by_user_id`, `invite_registered_reward_at`, `invite_plus_reward_at` data**.

Verification steps before committing:

1. Inspected live prod DB via `sqlite3 /opt/conductor/conductor.db ".schema users"` and `.schema agent_outbox` — confirmed both tables already match `schema.prisma`. Historical drift is in the migrations directory only.
2. Ran `SELECT user_id, name, COUNT(*) AS cnt FROM projects GROUP BY user_id, name HAVING cnt > 1` — no duplicates, so the new `UNIQUE (user_id, daemon_host, name)` constraint will hold (all existing rows have `daemon_host = NULL`).
3. Re-ran `prisma migrate diff --from-migrations --to-schema-datamodel` after adding the new migration file and confirmed the project-related deltas disappeared from the output. Only the pre-existing users/agent_outbox RedefineTables remained.

## How to avoid next time

1. **Never use `prisma db push` for schema changes that will ship.** Always use `prisma migrate dev --name <descriptive>`, which generates a migration file in the same step as it updates the local DB.
2. **Pre-release check**: before cutting any release that touches `web/prisma/schema.prisma`, run the following sanity check — the output for new schema changes in this release must be empty:
   ```
   web/node_modules/.bin/prisma migrate diff \
     --from-migrations web/prisma/migrations \
     --to-schema-datamodel web/prisma/schema.prisma --script
   ```
   Historical drift (users/agent_outbox) is expected until it is cleaned up separately.
3. **Release SOP addition**: `claw/sop/06_release.md` should include an explicit step "run `prisma migrate diff` and confirm no project-new deltas before pushing".
4. **Audit**: the historical drift for `users` and `agent_outbox` still lives in the migrations directory. A separate cleanup should either (a) add a backfill migration that records the current real state, or (b) squash all migrations into a single init migration that matches the live schema, and `prisma migrate resolve --applied` it on prod.

## Related incident artifacts

- Migration file: `web/prisma/migrations/20260409120000_add_project_daemon_binding/migration.sql`
- Release commit: (added on top of `release 0.2.33`)
- Bug type prefix: `arch` — architectural process issue in how schema changes were developed.
