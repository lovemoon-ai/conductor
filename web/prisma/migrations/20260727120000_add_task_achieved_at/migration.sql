-- Keep archived tasks and their transcripts while excluding them from the
-- active task surface. Runtime rows are removed by the archive workflow.
ALTER TABLE "tasks" ADD COLUMN "achieved_at" DATETIME;

CREATE INDEX "tasks_achieved_at_idx" ON "tasks"("achieved_at");
