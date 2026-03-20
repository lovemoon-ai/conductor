-- Migration: Persist task runtime execution host
-- Created: 2026-03-06

ALTER TABLE "tasks" ADD COLUMN "execution_host" TEXT;

CREATE INDEX "tasks_execution_host_idx" ON "tasks"("execution_host");
