-- Add relationship rows for in-place PTY terminals attached to AI tasks.
CREATE TABLE "attached_terminals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ai_task_id" TEXT NOT NULL,
    "pty_task_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "attached_terminals_ai_task_id_fkey" FOREIGN KEY ("ai_task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attached_terminals_pty_task_id_fkey" FOREIGN KEY ("pty_task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "attached_terminals_ai_task_id_key" ON "attached_terminals"("ai_task_id");
CREATE UNIQUE INDEX "attached_terminals_pty_task_id_key" ON "attached_terminals"("pty_task_id");
CREATE INDEX "attached_terminals_ai_task_id_idx" ON "attached_terminals"("ai_task_id");
CREATE INDEX "attached_terminals_pty_task_id_idx" ON "attached_terminals"("pty_task_id");
