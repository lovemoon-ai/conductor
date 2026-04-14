-- AlterTable
ALTER TABLE "projects" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing projects into the previous created_at-desc display order.
UPDATE "projects"
SET "sort_order" = (
  SELECT COUNT(*)
  FROM "projects" AS "ranked"
  WHERE
    "ranked"."user_id" = "projects"."user_id"
    AND (
      "ranked"."created_at" > "projects"."created_at"
      OR (
        "ranked"."created_at" = "projects"."created_at"
        AND "ranked"."id" <= "projects"."id"
      )
    )
) - 1;
