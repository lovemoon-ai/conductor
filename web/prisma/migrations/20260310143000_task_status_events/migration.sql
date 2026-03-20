CREATE TABLE "task_status_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "status_event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_status_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_status_events_status_event_id_key" ON "task_status_events"("status_event_id");
CREATE INDEX "task_status_events_task_id_created_at_idx" ON "task_status_events"("task_id", "created_at");
