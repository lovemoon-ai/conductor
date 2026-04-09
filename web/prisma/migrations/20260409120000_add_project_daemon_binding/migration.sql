-- Hand-written migration to recover from a missing migration: the
-- feat/refactor_projeect branch added DefaultProject + Project daemon/workspace
-- binding to schema.prisma and schema.postgres.prisma but forgot to generate a
-- migration file. See claw/lessons/arch_missing_project_daemon_binding_migration_20260409.md.
--
-- Safe to apply to prod: 13 existing projects all have daemon_host = NULL and
-- no (user_id, name) duplicates, so the new (user_id, daemon_host, name) unique
-- constraint holds without conflicts.

-- DropIndex
DROP INDEX "projects_user_id_name_key";

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "daemon_host" TEXT;
ALTER TABLE "projects" ADD COLUMN "workspace_path" TEXT;
ALTER TABLE "projects" ADD COLUMN "repo_root" TEXT;
ALTER TABLE "projects" ADD COLUMN "worktree_branch" TEXT;
ALTER TABLE "projects" ADD COLUMN "last_commit" TEXT;
ALTER TABLE "projects" ADD COLUMN "file_count" INTEGER;

-- CreateTable
CREATE TABLE "default_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "default_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "default_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "default_projects_user_id_key" ON "default_projects"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "default_projects_project_id_key" ON "default_projects"("project_id");

-- CreateIndex
CREATE INDEX "projects_user_id_name_idx" ON "projects"("user_id", "name");

-- CreateIndex
CREATE INDEX "projects_user_id_daemon_host_idx" ON "projects"("user_id", "daemon_host");

-- CreateIndex
CREATE INDEX "projects_user_id_workspace_path_idx" ON "projects"("user_id", "workspace_path");

-- CreateIndex
CREATE UNIQUE INDEX "projects_user_id_daemon_host_name_key" ON "projects"("user_id", "daemon_host", "name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_user_id_daemon_host_workspace_path_key" ON "projects"("user_id", "daemon_host", "workspace_path");
