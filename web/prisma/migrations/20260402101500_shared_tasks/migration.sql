-- CreateTable
CREATE TABLE "shared_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shared_tasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_tasks_token_key" ON "shared_tasks"("token");

-- CreateIndex
CREATE UNIQUE INDEX "shared_tasks_task_id_user_id_key" ON "shared_tasks"("task_id", "user_id");

-- CreateIndex
CREATE INDEX "shared_tasks_task_id_idx" ON "shared_tasks"("task_id");
