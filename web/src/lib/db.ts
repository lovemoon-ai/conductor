import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * Pin SQLite to one pooled connection, shared by the whole process. A writer
 * waiting for SQLite's lock busy-waits on one of Prisma's engine threads (one
 * per core); once they are all taken, an interactive transaction holding the
 * lock cannot run its next statement and times out (P2028), and the waiters
 * fail too (P1008). With one connection callers queue asynchronously instead,
 * so no-one busy-waits. SQLite allows a single writer anyway. An explicit
 * `connection_limit` in the URL wins.
 */
export function withSqliteConnectionLimit(url: string | undefined): string | undefined {
  if (!url?.trim().startsWith("file:") || /[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasourceUrl: withSqliteConnectionLimit(process.env.DATABASE_URL),
    // Interactive transactions now queue for the single connection; Prisma's
    // default 2s maxWait would fail them under bursts. Match pool_timeout.
    transactionOptions: { maxWait: 10_000 },
  });

// Cache in production too: server.ts (tsx) and the Next.js bundle each load
// this module, and one client per copy would mean one connection each.
globalForPrisma.prisma = db;

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
