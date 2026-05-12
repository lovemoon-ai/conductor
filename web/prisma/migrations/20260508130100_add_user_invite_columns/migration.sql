-- Migration: Add invite-code columns + indexes on users
-- Created: 2026-05-08
--
-- The invite-code feature has been declared in `schema.prisma` since the init
-- commit but **no migration file ever added these columns**. Local dev kept
-- working because Conductor's `pnpm db:push` flow rewrites the table from the
-- live schema. Production volc deploys run `prisma migrate deploy`, which only
-- replays migration files — so on volc these columns / indexes were missing
-- and every code path that touched `users.invite_code` would 500.
--
-- The four columns are all nullable, so adding them is safe online:
--   - `invite_code` (nullable TEXT, plus a unique index)
--   - `invited_by_user_id` (nullable TEXT, FK back to users.id with
--     ON DELETE SET NULL — matches the Prisma `User? @relation` semantics)
--   - `invite_registered_reward_at` (nullable DATETIME)
--   - `invite_plus_reward_at` (nullable DATETIME)
--
-- SQLite's ALTER TABLE ADD COLUMN with a REFERENCES clause is allowed when
-- the new column is nullable with NULL default, which is the case here.
-- No table rewrite, no data movement, existing rows keep all current values.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "invite_code" TEXT;
ALTER TABLE "users" ADD COLUMN "invited_by_user_id" TEXT REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD COLUMN "invite_registered_reward_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "invite_plus_reward_at" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "users_invite_code_key" ON "users"("invite_code");

-- CreateIndex
CREATE INDEX "users_invited_by_user_id_idx" ON "users"("invited_by_user_id");
