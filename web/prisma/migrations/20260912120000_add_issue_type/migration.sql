-- Classify each issue as a feature request or a bug. Existing rows predate the
-- distinction, so they default to "feature".
ALTER TABLE "issues" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'feature';
