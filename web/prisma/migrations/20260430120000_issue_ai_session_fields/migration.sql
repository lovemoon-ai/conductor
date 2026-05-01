-- Migration: Persist last-known AI backend type and session id on issues
-- Created: 2026-04-30
--
-- Tasks may be deleted (or unlinked) after their work is finished, but the
-- originating issue should still keep a breadcrumb pointing back to the AI
-- session that worked on it. These columns mirror the most recent non-empty
-- backend_type / session_id of any task associated with the issue.

ALTER TABLE "issues" ADD COLUMN "ai_backend_type" TEXT;
ALTER TABLE "issues" ADD COLUMN "ai_session_id" TEXT;
