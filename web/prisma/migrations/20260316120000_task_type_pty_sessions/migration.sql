-- Migration: add task_type/launch_config and pty_sessions table
-- Created: 2026-03-16

ALTER TABLE "tasks" ADD COLUMN "task_type" TEXT NOT NULL DEFAULT 'ai_task';
ALTER TABLE "tasks" ADD COLUMN "launch_config" TEXT;

CREATE TABLE "pty_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "entrypoint_type" TEXT,
    "tool_preset" TEXT,
    "command_json" TEXT,
    "cwd" TEXT,
    "env_json" TEXT,
    "shell" TEXT,
    "pid" INTEGER,
    "cols" INTEGER,
    "rows" INTEGER,
    "last_output_seq" INTEGER NOT NULL DEFAULT 0,
    "started_at" DATETIME,
    "closed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "pty_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pty_sessions_task_id_key" ON "pty_sessions"("task_id");
CREATE INDEX "pty_sessions_state_idx" ON "pty_sessions"("state");