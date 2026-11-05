import fs from "fs";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableSqliteWal, withSqliteConnectionLimit } from "@/lib/db";

describe("withSqliteConnectionLimit", () => {
  it("pins SQLite URLs to one connection", () => {
    expect(withSqliteConnectionLimit("file:/opt/conductor/conductor.db")).toBe(
      "file:/opt/conductor/conductor.db?connection_limit=1",
    );
    expect(withSqliteConnectionLimit("file:./dev.db?socket_timeout=10")).toBe(
      "file:./dev.db?socket_timeout=10&connection_limit=1",
    );
  });

  it("keeps an explicit limit, non-SQLite and missing URLs", () => {
    expect(withSqliteConnectionLimit("file:./dev.db?connection_limit=3")).toBe(
      "file:./dev.db?connection_limit=3",
    );
    expect(withSqliteConnectionLimit("postgresql://localhost/conductor")).toBe(
      "postgresql://localhost/conductor",
    );
    expect(withSqliteConnectionLimit(undefined)).toBeUndefined();
  });

  // Regression for the 2-core P2028 deadlock: an interactive transaction
  // holding the write lock must finish while other writers are queued.
  it("lets an interactive transaction finish under concurrent writers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-cl1-"));
    const url = withSqliteConnectionLimit(`file:${path.join(dir, "test.db")}`)!;
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      await client.$executeRawUnsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
      await client.$executeRawUnsafe("INSERT INTO t (id, v) VALUES (1, 0), (2, 0)");
      const tx = client.$transaction(async (t) => {
        await t.$executeRawUnsafe("UPDATE t SET v = v + 1 WHERE id = 1");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await t.$executeRawUnsafe("UPDATE t SET v = v + 1 WHERE id = 1");
      });
      const writers = Array.from({ length: 6 }, () =>
        client.$executeRawUnsafe("UPDATE t SET v = v + 1 WHERE id = 2"),
      );
      await Promise.all([tx, ...writers]);
      const rows = await client.$queryRawUnsafe<Array<{ id: number; v: number }>>(
        "SELECT id, v FROM t ORDER BY id",
      );
      expect(rows.map((row) => Number(row.v))).toEqual([2, 6]);
    } finally {
      await client.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
