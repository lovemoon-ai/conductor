-- CreateTable
CREATE TABLE "agent_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "agent_host" TEXT,
    "task_id" TEXT,
    "event_type" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" DATETIME,
    "last_error" TEXT,
    "sent_at" DATETIME,
    "acked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_outbox_request_id_key" ON "agent_outbox"("request_id");

-- CreateIndex
CREATE INDEX "agent_outbox_user_id_status_next_retry_at_idx" ON "agent_outbox"("user_id", "status", "next_retry_at");

-- CreateIndex
CREATE INDEX "agent_outbox_user_id_agent_host_status_next_retry_at_idx" ON "agent_outbox"("user_id", "agent_host", "status", "next_retry_at");

-- CreateIndex
CREATE INDEX "agent_outbox_task_id_idx" ON "agent_outbox"("task_id");
