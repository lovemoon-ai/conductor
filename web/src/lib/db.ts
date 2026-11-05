import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * Pin SQLite to one pooled connection. With several, a writer waiting for
 * SQLite's lock busy-waits on one of Prisma's engine threads (one per core);
 * on a 2-core host two such waiters starve an interactive transaction that
 * holds the lock, so it times out (P2028) and the waiters fail too (P1008).
 * One connection makes callers queue asynchronously instead. SQLite allows a
 * single writer anyway. An explicit `connection_limit` in the URL wins.
 */
export function withSqliteConnectionLimit(url: string | undefined): string | undefined {
  if (!url?.trim().startsWith("file:") || /[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({ datasourceUrl: withSqliteConnectionLimit(process.env.DATABASE_URL) });

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
