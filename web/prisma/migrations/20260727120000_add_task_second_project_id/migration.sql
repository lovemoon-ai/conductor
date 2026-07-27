-- Display-only secondary project for default-project tasks. When set, the
-- frontend renders the task under this project instead of the default project.
-- It never changes `project_id`, the daemon, or any runtime behaviour.
ALTER TABLE "tasks" ADD COLUMN "second_project_id" TEXT;

CREATE INDEX "tasks_second_project_id_idx" ON "tasks"("second_project_id");
