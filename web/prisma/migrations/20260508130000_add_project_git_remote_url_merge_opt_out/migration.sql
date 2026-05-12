-- Migration: Add git_remote_url and merge_opt_out columns on projects
-- Created: 2026-05-08
--
-- Backfills the schema change introduced by commit be3b3cb
-- ("merge same-name git projects across daemons by remote url"). That commit
-- updated `schema.prisma` only and told operators to run `pnpm -C web db:push`,
-- which is unsafe for the volc production deploy that uses `prisma migrate
-- deploy`. Without this migration, `migrate deploy` would leave the live DB
-- without these two columns and Prisma writes against them would 500.
--
-- Both columns are additive only:
--   - `git_remote_url` is nullable; pre-existing projects retain NULL and the
--     daemon backfills it on next `validate_project_path` refresh.
--   - `merge_opt_out` is NOT NULL with `DEFAULT 0`, which SQLite applies to
--     every existing row in one pass — no row-level rewrite required.
--
-- SQLite executes both `ALTER TABLE ADD COLUMN` statements as metadata-only,
-- so the migration is online-safe and preserves every existing column.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "git_remote_url" TEXT;
ALTER TABLE "projects" ADD COLUMN "merge_opt_out" BOOLEAN NOT NULL DEFAULT false;
