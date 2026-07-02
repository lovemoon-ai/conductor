import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDailyReportSchema } from "./schema";

const makeClient = () => ({
  $executeRawUnsafe: vi.fn().mockResolvedValue(0),
});

describe("daily report schema bootstrap", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates the local SQLite daily report tables and indexes", async () => {
    vi.stubEnv("DATABASE_URL", "file:/tmp/conductor.db");
    vi.stubEnv("DB_DIALECT", "sqlite");
    const client = makeClient();

    const result = await ensureDailyReportSchema(client);

    expect(result).toEqual({ attempted: true, statementsRun: 6 });
    expect(client.$executeRawUnsafe).toHaveBeenCalledTimes(6);
    expect(client.$executeRawUnsafe.mock.calls[0][0]).toContain(
      'CREATE TABLE IF NOT EXISTS "daily_report_settings"',
    );
    expect(client.$executeRawUnsafe.mock.calls[3][0]).toContain(
      'CREATE TABLE IF NOT EXISTS "daily_report_runs"',
    );
    expect(client.$executeRawUnsafe.mock.calls[0][0]).toContain(
      '"send_time_local" TEXT NOT NULL DEFAULT \'20:00\'',
    );
  });

  it("skips non-SQLite databases", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/conductor");
    vi.stubEnv("DB_DIALECT", "postgres");
    const client = makeClient();

    await expect(ensureDailyReportSchema(client)).resolves.toEqual({
      attempted: false,
      statementsRun: 0,
      skippedReason: "non-sqlite",
    });
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("returns an error result instead of throwing when bootstrap fails", async () => {
    vi.stubEnv("DATABASE_URL", "file:/tmp/conductor.db");
    vi.stubEnv("DB_DIALECT", "sqlite");
    const client = {
      $executeRawUnsafe: vi.fn().mockRejectedValue(new Error("disk is read-only")),
    };

    await expect(ensureDailyReportSchema(client)).resolves.toEqual({
      attempted: true,
      statementsRun: 0,
      skippedReason: "error",
      error: "disk is read-only",
    });
  });
});
