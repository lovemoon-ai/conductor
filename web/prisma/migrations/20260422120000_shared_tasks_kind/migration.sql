-- Distinguish user-facing shares from internal resume-handoff transcripts used
-- during cross-backend task restart.

-- SQLite: add column with a default, then rebuild the unique index to include
-- the new `kind` discriminator. Rebuilding is safe because the default
-- ('user') preserves existing rows' uniqueness semantics.
ALTER TABLE "shared_tasks" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'user';

DROP INDEX IF EXISTS "shared_tasks_task_id_user_id_key";

CREATE UNIQUE INDEX "shared_tasks_task_id_user_id_kind_key"
  ON "shared_tasks"("task_id", "user_id", "kind");
