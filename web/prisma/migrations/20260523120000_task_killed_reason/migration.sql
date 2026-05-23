-- RFC 0029: Task Reclaim on Restart.
-- Capture *why* an ai_task transitioned into `killed` so restart can decide
-- whether the underlying fire process is still reclaimable. Values are soft
-- enum strings: `user_stopped`, `daemon_disconnected`, `fire_exit`, `crash`,
-- `unknown`. Only `daemon_disconnected` triggers reclaim.
ALTER TABLE "tasks" ADD COLUMN "killed_reason" TEXT;
ALTER TABLE "tasks" ADD COLUMN "killed_at" DATETIME;

-- Existing killed rows have no recorded death cause; treat them as `unknown`
-- so the reclaim path never tries them (matches the conservative table in
-- the RFC).
UPDATE "tasks"
SET "killed_reason" = 'unknown'
WHERE "status" = 'killed'
  AND "killed_reason" IS NULL;
