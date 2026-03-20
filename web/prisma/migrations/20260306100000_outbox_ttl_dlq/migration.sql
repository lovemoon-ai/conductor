-- Migration: Add TTL and Dead Letter Queue support to AgentOutbox
-- Created: 2026-03-06

-- Add new columns to agent_outbox
ALTER TABLE "agent_outbox" ADD COLUMN "max_attempts" INTEGER DEFAULT 20;
ALTER TABLE "agent_outbox" ADD COLUMN "ttl_hours" INTEGER DEFAULT 24;
ALTER TABLE "agent_outbox" ADD COLUMN "expires_at" DATETIME;

-- Create index for expires_at
CREATE INDEX "agent_outbox_expires_at_idx" ON "agent_outbox"("expires_at");

-- Create Dead Letter Queue table
CREATE TABLE IF NOT EXISTS "dead_letter_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "original_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_host" TEXT,
    "task_id" TEXT,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "failed_reason" TEXT NOT NULL,
    "attempt_history" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create index for DLQ cleanup
CREATE INDEX "dead_letter_queue_created_at_idx" ON "dead_letter_queue"("created_at");

-- Update existing pending messages to have default values
UPDATE "agent_outbox"
SET 
    "max_attempts" = 20,
    "ttl_hours" = 24,
    "expires_at" = datetime(created_at/1000, 'unixepoch', '+24 hours')
WHERE "status" = 'pending' 
  AND "max_attempts" IS NULL;
