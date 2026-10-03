import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const db = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/**
 * Switch SQLite to WAL so readers no longer block writers (and vice versa).
 * In the default rollback-journal mode a commit waits for every open read,
 * so concurrent writes queue past Prisma's 5s busy timeout (P1008/P2028).
 * journal_mode is persisted in the database file, so one call at boot covers
 * every pooled connection. Non-SQLite databases are left untouched.
 */
export async function enableSqliteWal(
  client: Pick<PrismaClient, "$queryRawUnsafe"> = db,
): Promise<string | null> {
  if (!(process.env.DATABASE_URL?.trim() ?? "").startsWith("file:")) return null;
  const rows = await client.$queryRawUnsafe<Array<{ journal_mode: string }>>(
    "PRAGMA journal_mode=WAL;",
  );
  return rows[0]?.journal_mode ?? null;
}
