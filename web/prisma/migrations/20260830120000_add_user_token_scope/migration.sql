-- RFC 0035: Daemon Sharing.
-- A shared daemon runs on machine A but authenticates as user B, so the token it
-- carries must not be equivalent to full account access. `scope` is a soft enum
-- string: `full` (everything issued today) or `daemon_share` (restricted to one
-- share). `daemon_share_id` will point at `daemon_shares.id` once that table
-- exists; it is a plain nullable column for now, with no foreign key.
--
-- The NOT NULL DEFAULT backfills every existing row to `full`, which is correct:
-- every token minted before this migration is an unrestricted account token.
ALTER TABLE "user_tokens" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'full';
ALTER TABLE "user_tokens" ADD COLUMN "daemon_share_id" TEXT;
