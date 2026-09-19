-- Model token usage the daemon reports after each finished turn.
ALTER TABLE "tasks" ADD COLUMN "token_usage_total" REAL NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN "last_turn_token_usage" INTEGER;
