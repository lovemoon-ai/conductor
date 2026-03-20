CREATE TABLE "external_accounts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "external_user_id" TEXT NOT NULL,
  "external_union_id" TEXT,
  "tenant_key" TEXT,
  "metadata" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "external_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "external_accounts_provider_external_user_id_key" ON "external_accounts"("provider", "external_user_id");
CREATE UNIQUE INDEX "external_accounts_provider_external_union_id_key" ON "external_accounts"("provider", "external_union_id");
CREATE INDEX "external_accounts_user_id_idx" ON "external_accounts"("user_id");

CREATE TABLE "channel_conversations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "external_chat_id" TEXT NOT NULL,
  "external_thread_id" TEXT NOT NULL DEFAULT '',
  "external_root_message_id" TEXT,
  "user_id" TEXT NOT NULL,
  "project_id" TEXT,
  "task_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "metadata" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "channel_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "channel_conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "channel_conversations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "channel_conversations_provider_external_chat_id_external_thread_id_key" ON "channel_conversations"("provider", "external_chat_id", "external_thread_id");
CREATE INDEX "channel_conversations_user_id_task_id_idx" ON "channel_conversations"("user_id", "task_id");
CREATE INDEX "channel_conversations_project_id_idx" ON "channel_conversations"("project_id");

CREATE TABLE "channel_inbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "external_event_id" TEXT,
  "external_message_id" TEXT NOT NULL,
  "conversation_id" TEXT,
  "payload_json" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" DATETIME,
  CONSTRAINT "channel_inbox_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "channel_conversations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "channel_inbox_provider_external_message_id_key" ON "channel_inbox"("provider", "external_message_id");
CREATE INDEX "channel_inbox_provider_external_event_id_idx" ON "channel_inbox"("provider", "external_event_id");
CREATE INDEX "channel_inbox_conversation_id_idx" ON "channel_inbox"("conversation_id");

CREATE TABLE "channel_outbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "task_id" TEXT,
  "target_chat_id" TEXT NOT NULL,
  "target_reply_message_id" TEXT,
  "target_thread_id" TEXT,
  "target_topic_id" TEXT,
  "event_type" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "payload_json" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" DATETIME,
  "last_error" TEXT,
  "sent_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "channel_outbox_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "channel_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "channel_outbox_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "channel_outbox_dedupe_key_key" ON "channel_outbox"("dedupe_key");
CREATE INDEX "channel_outbox_status_next_retry_at_idx" ON "channel_outbox"("status", "next_retry_at");
CREATE INDEX "channel_outbox_user_id_task_id_idx" ON "channel_outbox"("user_id", "task_id");
CREATE INDEX "channel_outbox_conversation_id_idx" ON "channel_outbox"("conversation_id");
