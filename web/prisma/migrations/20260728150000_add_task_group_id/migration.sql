-- RFC 0033: link a worker task and its reviewer siblings so every member can
-- discover the execution group without embedding task ids in prompts.
ALTER TABLE "tasks" ADD COLUMN "group_id" TEXT;

CREATE INDEX "tasks_group_id_idx" ON "tasks"("group_id");
