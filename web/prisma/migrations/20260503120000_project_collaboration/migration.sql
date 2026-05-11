-- CreateTable
CREATE TABLE "project_collaborations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invite_token" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "collaboration_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collaboration_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "joined_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "collaboration_members_collaboration_id_fkey" FOREIGN KEY ("collaboration_id") REFERENCES "project_collaborations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "collaboration_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "collaboration_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "daemon_host" TEXT,
    "workspace_path" TEXT,
    "repo_root" TEXT,
    "worktree_branch" TEXT,
    "last_commit" TEXT,
    "file_count" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "hidden_at" DATETIME,
    "collaboration_id" TEXT,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "projects_collaboration_id_fkey" FOREIGN KEY ("collaboration_id") REFERENCES "project_collaborations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_projects" (
    "created_at",
    "daemon_host",
    "file_count",
    "hidden_at",
    "id",
    "last_commit",
    "metadata",
    "name",
    "repo_root",
    "sort_order",
    "updated_at",
    "user_id",
    "workspace_path",
    "worktree_branch"
) SELECT
    "created_at",
    "daemon_host",
    "file_count",
    "hidden_at",
    "id",
    "last_commit",
    "metadata",
    "name",
    "repo_root",
    "sort_order",
    "updated_at",
    "user_id",
    "workspace_path",
    "worktree_branch"
FROM "projects";

DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";

CREATE TABLE "new_issues" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "creator_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "priority" TEXT NOT NULL DEFAULT 'P1',
    "position" REAL NOT NULL DEFAULT 0,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "issues_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "issues_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_issues" (
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
    "issues"."created_at",
    "projects"."user_id",
    "issues"."description",
    "issues"."id",
    "issues"."metadata",
    "projects"."user_id",
    "issues"."position",
    "issues"."priority",
    "issues"."project_id",
    "issues"."status",
    "issues"."title",
    "issues"."updated_at"
FROM "issues"
JOIN "projects" ON "projects"."id" = "issues"."project_id";

DROP TABLE "issues";
ALTER TABLE "new_issues" RENAME TO "issues";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "project_collaborations_invite_token_key" ON "project_collaborations"("invite_token");

-- CreateIndex
CREATE UNIQUE INDEX "collaboration_members_project_id_key" ON "collaboration_members"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "collaboration_members_collaboration_id_user_id_key" ON "collaboration_members"("collaboration_id", "user_id");

-- CreateIndex
CREATE INDEX "collaboration_members_user_id_idx" ON "collaboration_members"("user_id");

-- CreateIndex
CREATE INDEX "collaboration_members_collaboration_id_idx" ON "collaboration_members"("collaboration_id");

-- CreateIndex
CREATE INDEX "projects_user_id_idx" ON "projects"("user_id");

-- CreateIndex
CREATE INDEX "projects_user_id_name_idx" ON "projects"("user_id", "name");

-- CreateIndex
CREATE INDEX "projects_user_id_daemon_host_idx" ON "projects"("user_id", "daemon_host");

-- CreateIndex
CREATE INDEX "projects_user_id_workspace_path_idx" ON "projects"("user_id", "workspace_path");

-- CreateIndex
CREATE INDEX "projects_user_id_hidden_at_idx" ON "projects"("user_id", "hidden_at");

-- CreateIndex
CREATE INDEX "projects_collaboration_id_idx" ON "projects"("collaboration_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_user_id_daemon_host_name_key" ON "projects"("user_id", "daemon_host", "name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_user_id_daemon_host_workspace_path_key" ON "projects"("user_id", "daemon_host", "workspace_path");

-- CreateIndex
CREATE INDEX "issues_project_id_idx" ON "issues"("project_id");

-- CreateIndex
CREATE INDEX "issues_project_id_status_position_idx" ON "issues"("project_id", "status", "position");

-- CreateIndex
CREATE INDEX "issues_owner_user_id_idx" ON "issues"("owner_user_id");

-- CreateIndex
CREATE INDEX "issues_creator_user_id_idx" ON "issues"("creator_user_id");
