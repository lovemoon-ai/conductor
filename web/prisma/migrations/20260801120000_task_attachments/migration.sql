CREATE TABLE "task_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "message_id" TEXT,
    "original_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "materialized_host" TEXT,
    "materialized_at" DATETIME,
    "bound_at" DATETIME,
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_attachments_storage_key_key" ON "task_attachments"("storage_key");
CREATE INDEX "task_attachments_task_id_status_idx" ON "task_attachments"("task_id", "status");
CREATE INDEX "task_attachments_message_id_idx" ON "task_attachments"("message_id");
CREATE INDEX "task_attachments_expires_at_idx" ON "task_attachments"("expires_at");
