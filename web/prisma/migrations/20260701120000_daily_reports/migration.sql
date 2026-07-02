-- User-level daily reports. Settings are separate from user_preferences because
-- generated runs need history, idempotency, and delivery state.
CREATE TABLE "daily_report_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "send_time_local" TEXT NOT NULL DEFAULT '20:00',
    "delivery_channels" TEXT NOT NULL DEFAULT '["in_app"]',
    "next_run_at" DATETIME,
    "last_sent_for_date" TEXT,
    "last_run_at" DATETIME,
    "last_error" TEXT,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "daily_report_settings_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "daily_report_settings_user_id_key"
  ON "daily_report_settings"("user_id");
CREATE INDEX "daily_report_settings_enabled_next_run_at_idx"
  ON "daily_report_settings"("enabled", "next_run_at");

CREATE TABLE "daily_report_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "report_date" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "summary_markdown" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "delivery_channels" TEXT NOT NULL DEFAULT '["in_app"]',
    "sent_at" DATETIME,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "daily_report_runs_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "daily_report_runs_user_id_report_date_key"
  ON "daily_report_runs"("user_id", "report_date");
CREATE INDEX "daily_report_runs_user_id_created_at_idx"
  ON "daily_report_runs"("user_id", "created_at");
