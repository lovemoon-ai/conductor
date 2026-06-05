-- Align issue ownership columns with the current Prisma schema.
-- These columns are optional at the application layer, so existing rows must
-- not require owner/creator values.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_issues" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "creator_user_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "priority" TEXT NOT NULL DEFAULT 'P1',
    "position" REAL NOT NULL DEFAULT 0,
    "metadata" TEXT,
    "ai_backend_type" TEXT,
    "ai_session_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "issues_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "issues_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_issues" (
    "ai_backend_type",
    "ai_session_id",
    "created_at",
    "creator_user_id",
    "description",
    "id",
    "metadata",
    "owner_user_id",
    "position",
    "priority",
    "project_id",
    "status",
    "title",
    "updated_at"
) SELECT
    "ai_backend_type",
    "ai_session_id",
    "created_at",
    "creator_user_id",
    "description",
    "id",
    "metadata",
    "owner_user_id",
    "position",
    "priority",
    "project_id",
    "status",
    "title",
    "updated_at"
FROM "issues";

DROP TABLE "issues";
ALTER TABLE "new_issues" RENAME TO "issues";

CREATE INDEX "issues_project_id_idx" ON "issues"("project_id");
CREATE INDEX "issues_project_id_status_position_idx" ON "issues"("project_id", "status", "position");
CREATE INDEX "issues_owner_user_id_idx" ON "issues"("owner_user_id");
CREATE INDEX "issues_creator_user_id_idx" ON "issues"("creator_user_id");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
