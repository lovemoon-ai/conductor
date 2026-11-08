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

  // server.ts (tsx) and the Next.js bundle each evaluate db.ts; they must
  // share one client, or each copy adds its own connection (and busy-waiter).
  it("shares one client across module copies in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const globalForPrisma = globalThis as unknown as { prisma?: unknown };
    const previous = globalForPrisma.prisma;
    delete globalForPrisma.prisma;
    try {
      vi.resetModules();
      const first = (await import("@/lib/db")).db;
      vi.resetModules();
      const second = (await import("@/lib/db")).db;
      expect(second).toBe(first);
      await first.$disconnect();
    } finally {
      globalForPrisma.prisma = previous;
      vi.unstubAllEnvs();
      vi.resetModules();
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
