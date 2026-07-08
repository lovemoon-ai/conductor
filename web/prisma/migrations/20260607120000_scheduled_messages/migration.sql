-- Persist delayed and recurring chat sends. The dispatcher claims due rows
-- atomically and reuses the normal task message ingress path.
CREATE TABLE "scheduled_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "source_message_id" TEXT,
    "content" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "condition" TEXT NOT NULL DEFAULT 'none',
    "interval_ms" INTEGER,
    "timezone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "next_run_at" DATETIME NOT NULL,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "skip_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "max_runs" INTEGER,
    "max_skips" INTEGER,
    "stop_at" DATETIME,
    "stop_when_task_not_running" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" DATETIME,
    "last_error" TEXT,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "scheduled_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scheduled_messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "scheduled_messages_user_id_status_next_run_at_idx" ON "scheduled_messages"("user_id", "status", "next_run_at");
CREATE INDEX "scheduled_messages_task_id_status_idx" ON "scheduled_messages"("task_id", "status");
CREATE INDEX "scheduled_messages_status_next_run_at_idx" ON "scheduled_messages"("status", "next_run_at");
CREATE INDEX "scheduled_messages_source_message_id_idx" ON "scheduled_messages"("source_message_id");

-- Latest runtime status reported by fire/agent. This lets the scheduler make
-- server-side "AI is idle" decisions when a browser tab is closed.
CREATE TABLE "task_runtime_states" (
    "task_id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT,
    "state" TEXT,
    "phase" TEXT,
    "source" TEXT,
    "reply_in_progress" BOOLEAN NOT NULL DEFAULT false,
    "status_line" TEXT,
    "status_done_line" TEXT,
    "reply_preview" TEXT,
    "reply_to" TEXT,
    "backend" TEXT,
    "session_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_runtime_states_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "task_runtime_states_project_id_idx" ON "task_runtime_states"("project_id");
