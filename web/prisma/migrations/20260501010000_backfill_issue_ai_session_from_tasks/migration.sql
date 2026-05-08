-- Migration: Backfill issue ai_backend_type / ai_session_id from existing tasks
-- Created: 2026-05-01
--
-- The previous migration (20260430120000_issue_ai_session_fields) added the
-- columns and the application code mirrors them on every task creation /
-- restart / PATCH that carries session info. But pre-existing tasks already
-- finished their session-binding handshake before that hook shipped, so their
-- linked issues are still NULL even though the task rows still hold the
-- session id and backend type. Without this backfill, deleting any such task
-- destroys the only surviving copy of the breadcrumb.
--
-- Strategy: for every issue whose breadcrumb columns are still NULL, copy in
-- the most-recent non-empty value from any task that points at the issue. We
-- run two independent UPDATEs so a task that has only one of the two fields
-- still contributes what it knows.

UPDATE "issues"
SET "ai_backend_type" = (
  SELECT t."backend_type"
  FROM "tasks" t
  WHERE t."issue_id" = "issues"."id"
    AND t."backend_type" IS NOT NULL
    AND TRIM(t."backend_type") <> ''
  ORDER BY t."updated_at" DESC, t."created_at" DESC
  LIMIT 1
)
WHERE "ai_backend_type" IS NULL;

UPDATE "issues"
SET "ai_session_id" = (
  SELECT t."session_id"
  FROM "tasks" t
  WHERE t."issue_id" = "issues"."id"
    AND t."session_id" IS NOT NULL
    AND TRIM(t."session_id") <> ''
  ORDER BY t."updated_at" DESC, t."created_at" DESC
  LIMIT 1
)
WHERE "ai_session_id" IS NULL;
