-- CreateTable
CREATE TABLE "task_diagnostics_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "task_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "task_diagnostics_snapshots_user_id_task_id_created_at_idx" ON "task_diagnostics_snapshots"("user_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_diagnostics_snapshots_project_id_created_at_idx" ON "task_diagnostics_snapshots"("project_id", "created_at");
