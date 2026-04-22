-- Add a real FOREIGN KEY from shared_tasks.user_id to users.id so that
-- deleting a user also wipes their share rows (both user-facing and internal
-- resume-handoff). SQLite does not support adding a FK to an existing table,
-- so we rebuild the table in place. The transaction wrapper is implicit
-- under Prisma's migrate runner.

-- Pre-flight: drop any orphan rows whose user_id no longer references an
-- existing user. Without this, the INSERT ... SELECT below would hard-fail
-- under foreign_keys=ON because the new table enforces the FK. Orphans
-- should be rare (users are seldom deleted) but this is a cheap safety net
-- for any deployment where the old user-less constraint was relied on.
DELETE FROM "shared_tasks"
WHERE "user_id" NOT IN (SELECT "id" FROM "users");

PRAGMA foreign_keys=OFF;

CREATE TABLE "shared_tasks_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'user',
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shared_tasks_task_id_fkey"
      FOREIGN KEY ("task_id") REFERENCES "tasks" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "shared_tasks_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "shared_tasks_new" ("id", "task_id", "user_id", "token", "kind", "expires_at", "created_at")
SELECT "id", "task_id", "user_id", "token", "kind", "expires_at", "created_at"
FROM "shared_tasks";

DROP TABLE "shared_tasks";

ALTER TABLE "shared_tasks_new" RENAME TO "shared_tasks";

CREATE UNIQUE INDEX "shared_tasks_token_key" ON "shared_tasks"("token");
CREATE UNIQUE INDEX "shared_tasks_task_id_user_id_kind_key"
  ON "shared_tasks"("task_id", "user_id", "kind");
CREATE INDEX "shared_tasks_task_id_idx" ON "shared_tasks"("task_id");
CREATE INDEX "shared_tasks_user_id_idx" ON "shared_tasks"("user_id");

PRAGMA foreign_keys=ON;
