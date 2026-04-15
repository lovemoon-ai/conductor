-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "position" REAL NOT NULL DEFAULT 0,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "issue_id" TEXT,
    "title" TEXT NOT NULL,
    "task_type" TEXT NOT NULL DEFAULT 'ai_task',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "agent_host" TEXT,
    "execution_host" TEXT,
    "backend_type" TEXT,
    "session_id" TEXT,
    "session_file_path" TEXT,
    "launch_config" TEXT,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tasks_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_tasks" (
    "agent_host",
    "backend_type",
    "created_at",
    "execution_host",
    "id",
    "launch_config",
    "metadata",
    "project_id",
    "session_file_path",
    "session_id",
    "status",
    "task_type",
    "title",
    "updated_at"
) SELECT
    "agent_host",
    "backend_type",
    "created_at",
    "execution_host",
    "id",
    "launch_config",
    "metadata",
    "project_id",
    "session_file_path",
    "session_id",
    "status",
    "task_type",
    "title",
    "updated_at"
FROM "tasks";
DROP TABLE "tasks";
ALTER TABLE "new_tasks" RENAME TO "tasks";
CREATE INDEX "tasks_project_id_idx" ON "tasks"("project_id");
CREATE INDEX "tasks_issue_id_idx" ON "tasks"("issue_id");
CREATE INDEX "tasks_execution_host_idx" ON "tasks"("execution_host");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "issues_project_id_idx" ON "issues"("project_id");

-- CreateIndex
CREATE INDEX "issues_project_id_status_position_idx" ON "issues"("project_id", "status", "position");
