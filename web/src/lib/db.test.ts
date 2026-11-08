import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableSqliteWal } from "@/lib/db";

describe("enableSqliteWal", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("persists WAL journal mode on a SQLite database", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-wal-"));
    const url = `file:${path.join(dir, "test.db")}`;
    vi.stubEnv("DATABASE_URL", url);
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      expect(await enableSqliteWal(client)).toBe("wal");
      const rows = await client.$queryRawUnsafe<Array<{ journal_mode: string }>>(
        "PRAGMA journal_mode;",
      );
      expect(rows[0]?.journal_mode).toBe("wal");
    } finally {
      await client.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips non-SQLite databases", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/conductor");
    const client = { $queryRawUnsafe: vi.fn() };
    expect(await enableSqliteWal(client as never)).toBeNull();
    expect(client.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
