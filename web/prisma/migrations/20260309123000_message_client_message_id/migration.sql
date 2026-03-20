-- Migration: add client_message_id to messages
-- Created: 2026-03-09

ALTER TABLE "messages" ADD COLUMN "client_message_id" TEXT;

CREATE UNIQUE INDEX "messages_client_message_id_key" ON "messages"("client_message_id");
CREATE INDEX "messages_client_message_id_idx" ON "messages"("client_message_id");
