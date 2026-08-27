import { db as defaultDb } from "@/lib/db";

/**
 * Whole-history message search (borrowed from AgentsServer's cross-chat FTS).
 *
 * On SQLite (the default Conductor dialect) this maintains an FTS5 virtual
 * table `message_search` that mirrors `messages.content`, kept in sync by
 * triggers so indexing is incremental and free. Queries use `MATCH` with
 * prefix terms for responsive type-ahead search and rank ordering.
 *
 * The whole feature is additive and fails closed to a portable `LIKE` scan:
 * if the FTS schema cannot be created (e.g. FTS5 missing, or a non-SQLite
 * dialect), `ensureMessageSearchSchema` reports it as skipped and
 * `searchMessages` transparently falls back to a Prisma `contains` query. No
 * caller ever sees a hard failure just because the index is unavailable.
 */

type RawExecutor = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(sql: string, ...values: unknown[]) => Promise<T>;
};

const FTS_TABLE = "message_search";
const MAX_QUERY_CHARS = 256;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export type MessageSearchSchemaResult = {
  attempted: boolean;
  available: boolean;
  skippedReason?: "non-sqlite" | "missing-database-url" | "error";
  error?: string;
};

export type MessageSearchHit = {
  taskId: string;
  taskTitle: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: string;
};

export type MessageSearchResult = {
  query: string;
  backend: "fts" | "like";
  hits: MessageSearchHit[];
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isSqliteDatabase = (): boolean => {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    return false;
  }
  const dialect = process.env.DB_DIALECT?.trim().toLowerCase();
  return dialect === "sqlite" || databaseUrl.startsWith("file:");
};

// Per-module-instance memo of whether the FTS index is usable. `null` means
// "not yet resolved in this module instance". This must NOT rely solely on the
// boot-time `ensureMessageSearchSchema` call: in a Next.js production build the
// custom server (server.ts) and the compiled route handlers run in separate
// module instances, so a flag set at boot is invisible to the route. Instead
// `searchMessages` lazily resolves availability in its own instance via the
// idempotent `ensureMessageSearchSchema`.
let ftsState: boolean | null = null;
let ftsInitPromise: Promise<boolean> | null = null;

async function resolveFtsAvailability(client: RawExecutor): Promise<boolean> {
  if (ftsState !== null) {
    return ftsState;
  }
  if (!ftsInitPromise) {
    ftsInitPromise = ensureMessageSearchSchema(client)
      .then((result) => result.available)
      .catch(() => {
        ftsState = false;
        return false;
      });
  }
  return ftsInitPromise;
}

const MESSAGE_SEARCH_SCHEMA_SQL = [
  `
CREATE VIRTUAL TABLE IF NOT EXISTS "${FTS_TABLE}" USING fts5(
  content,
  message_id UNINDEXED,
  task_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
)
  `.trim(),
  `
CREATE TRIGGER IF NOT EXISTS "message_search_ai" AFTER INSERT ON "messages" BEGIN
  INSERT INTO "${FTS_TABLE}"(content, message_id, task_id)
  VALUES (new."content", new."id", new."task_id");
END
  `.trim(),
  `
CREATE TRIGGER IF NOT EXISTS "message_search_ad" AFTER DELETE ON "messages" BEGIN
  DELETE FROM "${FTS_TABLE}" WHERE message_id = old."id";
END
  `.trim(),
  `
CREATE TRIGGER IF NOT EXISTS "message_search_au" AFTER UPDATE OF "content" ON "messages" BEGIN
  DELETE FROM "${FTS_TABLE}" WHERE message_id = old."id";
  INSERT INTO "${FTS_TABLE}"(content, message_id, task_id)
  VALUES (new."content", new."id", new."task_id");
END
  `.trim(),
];

/**
 * Idempotently create the FTS5 mirror table and its sync triggers. Safe to
 * call on every boot. Mirrors `daily-reports/schema.ts`: on a non-SQLite
 * dialect or any error it reports the reason and leaves search on the LIKE
 * fallback rather than crashing startup.
 */
export async function ensureMessageSearchSchema(
  client: RawExecutor = defaultDb as unknown as RawExecutor,
): Promise<MessageSearchSchemaResult> {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    ftsState = false;
    return { attempted: false, available: false, skippedReason: "missing-database-url" };
  }
  if (!isSqliteDatabase()) {
    ftsState = false;
    return { attempted: false, available: false, skippedReason: "non-sqlite" };
  }
  try {
    for (const sql of MESSAGE_SEARCH_SCHEMA_SQL) {
      await client.$executeRawUnsafe(sql);
    }
    ftsState = true;
    return { attempted: true, available: true };
  } catch (error) {
    ftsState = false;
    return { attempted: true, available: false, skippedReason: "error", error: errorMessage(error) };
  }
}

/**
 * One-time incremental backfill of rows that predate the triggers.
 *
 * The `INSERT ... NOT EXISTS` below is O(messages × fts_rows): `message_id` is
 * an FTS5 UNINDEXED column, so the equality inside `NOT EXISTS` cannot use an
 * index and scans the FTS content for every message row. Running that on every
 * boot would be very expensive on large histories. But the triggers keep the
 * index in sync after the first backfill, and the app server is the only writer
 * (no message writes happen while it is down), so a full backfill is only
 * needed while the index is actually behind. We guard on a cheap `COUNT(*)`
 * comparison so steady-state boots (counts already equal) skip the scan
 * entirely; the expensive path runs only the first time, when the FTS table is
 * (near-)empty and the scan is effectively O(messages).
 */
export async function backfillMessageSearchIndex(
  client: RawExecutor = defaultDb as unknown as RawExecutor,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!ftsState) {
    return { ok: false, error: "fts-unavailable" };
  }
  try {
    const rows = await client.$queryRawUnsafe<Array<{ missing: number | bigint }>>(
      `SELECT (SELECT COUNT(*) FROM "messages")
              - (SELECT COUNT(*) FROM "${FTS_TABLE}") AS missing`,
    );
    const missing = Number(rows?.[0]?.missing ?? 0);
    if (missing <= 0) {
      return { ok: true, skipped: true };
    }
    await client.$executeRawUnsafe(
      `INSERT INTO "${FTS_TABLE}"(content, message_id, task_id)
       SELECT m."content", m."id", m."task_id"
       FROM "messages" m
       WHERE NOT EXISTS (
         SELECT 1 FROM "${FTS_TABLE}" ms WHERE ms.message_id = m."id"
       )`,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

const clampLimit = (limit: number | undefined): number => {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
};

/**
 * Turn a free-text query into a safe FTS5 MATCH expression. Each whitespace
 * term becomes a quoted prefix term (`"term"*`) AND-ed together, so unquoted
 * input behaves as responsive type-ahead prefix search. FTS syntax characters
 * inside terms are neutralised by double-quoting.
 */
export function buildFtsMatchQuery(query: string): string {
  const terms = query
    .slice(0, MAX_QUERY_CHARS)
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, "").trim())
    .filter(Boolean)
    .map((term) => `"${term}"*`);
  return terms.join(" ");
}

type FtsRow = {
  message_id: string;
  task_id: string;
  role: string;
  snippet: string;
  created_at: string | Date;
};

const toIso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

async function searchWithFts(
  client: RawExecutor,
  userId: string,
  query: string,
  limit: number,
): Promise<MessageSearchHit[] | null> {
  const match = buildFtsMatchQuery(query);
  if (!match) return [];
  try {
    const rows = await client.$queryRawUnsafe<FtsRow[]>(
      `SELECT ms.message_id AS message_id,
              ms.task_id AS task_id,
              m."role" AS role,
              m."created_at" AS created_at,
              t."title" AS task_title,
              snippet("${FTS_TABLE}", 0, '[', ']', '…', 12) AS snippet
       FROM "${FTS_TABLE}" ms
       JOIN "messages" m ON m."id" = ms.message_id
       JOIN "tasks" t ON t."id" = ms.task_id
       JOIN "projects" p ON p."id" = t."project_id"
       WHERE "${FTS_TABLE}" MATCH ? AND p."user_id" = ?
       ORDER BY rank
       LIMIT ?`,
      match,
      userId,
      limit,
    );
    return rows.map((row) => ({
      taskId: row.task_id,
      taskTitle: (row as unknown as { task_title?: string }).task_title ?? "",
      messageId: row.message_id,
      role: row.role,
      snippet: row.snippet,
      createdAt: toIso(row.created_at),
    }));
  } catch {
    // A malformed MATCH expression or a dropped index should degrade to LIKE
    // rather than surfacing a 500 to the caller.
    return null;
  }
}

async function searchWithLike(
  userId: string,
  query: string,
  limit: number,
): Promise<MessageSearchHit[]> {
  const messages = await defaultDb.message.findMany({
    where: {
      content: { contains: query },
      task: { project: { userId } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
      taskId: true,
      task: { select: { title: true } },
    },
  });
  return messages.map((message) => ({
    taskId: message.taskId,
    taskTitle: message.task?.title ?? "",
    messageId: message.id,
    role: message.role,
    snippet: buildLikeSnippet(message.content, query),
    createdAt: message.createdAt.toISOString(),
  }));
}

const buildLikeSnippet = (content: string, query: string): string => {
  const normalized = content.replace(/\s+/g, " ").trim();
  const idx = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) {
    return normalized.slice(0, 160);
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(normalized.length, idx + query.length + 80);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
};

/**
 * Search every message across all of the user's tasks. Uses the FTS index when
 * available, otherwise a portable case-insensitive LIKE scan.
 */
export async function searchMessages(input: {
  userId: string;
  query: string;
  limit?: number;
  client?: RawExecutor;
}): Promise<MessageSearchResult> {
  const client = input.client ?? (defaultDb as unknown as RawExecutor);
  const query = input.query.trim().slice(0, MAX_QUERY_CHARS);
  const limit = clampLimit(input.limit);
  if (!query) {
    return { query, backend: "like", hits: [] };
  }
  // Resolve FTS availability in THIS module instance (lazy, idempotent) so the
  // route handler uses the index regardless of whether server.ts boot ran in
  // the same module graph.
  const available = await resolveFtsAvailability(client);
  if (available) {
    const hits = await searchWithFts(client, input.userId, query, limit);
    if (hits !== null) {
      return { query, backend: "fts", hits };
    }
  }
  return { query, backend: "like", hits: await searchWithLike(input.userId, query, limit) };
}

/** Test-only override of the cached availability state. */
export function __setFtsAvailableForTests(value: boolean): void {
  ftsState = value;
  ftsInitPromise = Promise.resolve(value);
}

/** Test-only reset to the un-probed state so lazy self-init can be exercised. */
export function __resetFtsStateForTests(): void {
  ftsState = null;
  ftsInitPromise = null;
}
