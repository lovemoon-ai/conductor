import { db as defaultDb } from "@/lib/db";

type RawExecutor = {
  $executeRawUnsafe: (sql: string) => Promise<number>;
};

export type DailyReportSchemaEnsureResult = {
  attempted: boolean;
  statementsRun: number;
  skippedReason?: "non-sqlite" | "missing-database-url" | "error";
  error?: string;
};

const isSqliteDatabase = (): boolean => {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    return false;
  }
  const dialect = process.env.DB_DIALECT?.trim().toLowerCase();
  return dialect === "sqlite" || databaseUrl.startsWith("file:");
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const DAILY_REPORT_SCHEMA_SQL = [
  `
CREATE TABLE IF NOT EXISTS "daily_report_settings" (
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
)
  `.trim(),
  `
CREATE UNIQUE INDEX IF NOT EXISTS "daily_report_settings_user_id_key"
  ON "daily_report_settings"("user_id")
  `.trim(),
  `
CREATE INDEX IF NOT EXISTS "daily_report_settings_enabled_next_run_at_idx"
  ON "daily_report_settings"("enabled", "next_run_at")
  `.trim(),
  `
CREATE TABLE IF NOT EXISTS "daily_report_runs" (
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
)
  `.trim(),
  `
CREATE UNIQUE INDEX IF NOT EXISTS "daily_report_runs_user_id_report_date_key"
  ON "daily_report_runs"("user_id", "report_date")
  `.trim(),
  `
CREATE INDEX IF NOT EXISTS "daily_report_runs_user_id_created_at_idx"
  ON "daily_report_runs"("user_id", "created_at")
  `.trim(),
];

export async function ensureDailyReportSchema(
  client: RawExecutor = defaultDb as unknown as RawExecutor,
): Promise<DailyReportSchemaEnsureResult> {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    return { attempted: false, statementsRun: 0, skippedReason: "missing-database-url" };
  }
  if (!isSqliteDatabase()) {
    return { attempted: false, statementsRun: 0, skippedReason: "non-sqlite" };
  }

  let statementsRun = 0;
  try {
    for (const sql of DAILY_REPORT_SCHEMA_SQL) {
      await client.$executeRawUnsafe(sql);
      statementsRun += 1;
    }
    return { attempted: true, statementsRun };
  } catch (error) {
    return {
      attempted: true,
      statementsRun,
      skippedReason: "error",
      error: errorMessage(error),
    };
  }
}
