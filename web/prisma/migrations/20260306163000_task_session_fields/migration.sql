-- Migration: Persist task backend and session binding fields
-- Created: 2026-03-06

ALTER TABLE "tasks" ADD COLUMN "backend_type" TEXT;
ALTER TABLE "tasks" ADD COLUMN "session_id" TEXT;
ALTER TABLE "tasks" ADD COLUMN "session_file_path" TEXT;
