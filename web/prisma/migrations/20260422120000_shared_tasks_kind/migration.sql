-- Distinguish user-facing shares from internal resume-handoff transcripts used
-- during cross-backend task restart.

-- SQLite: add column with a default, then rebuild the unique index to include
-- the new `kind` discriminator. Rebuilding is safe because the default
-- ('user') preserves existing rows' uniqueness semantics.
--
-- Note on idempotency: `ALTER TABLE ADD COLUMN` is NOT natively idempotent in
-- SQLite (no `IF NOT EXISTS` on column), but the Prisma `_prisma_migrations`
-- table records which migrations have been applied and prevents double-apply
-- in the normal path. `DROP INDEX IF EXISTS` and `CREATE UNIQUE INDEX IF NOT
-- EXISTS` are used to make the index portion safe to replay during recovery
-- scenarios where the migration ran partially.
ALTER TABLE "shared_tasks" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user';

DROP INDEX IF EXISTS "shared_tasks_task_id_user_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "shared_tasks_task_id_user_id_kind_key"
  ON "shared_tasks"("task_id", "user_id", "kind");
