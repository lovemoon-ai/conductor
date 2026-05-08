import { db as defaultDb } from '@/lib/db';

/**
 * Idempotent boot-time backfill that mirrors the most-recent non-empty
 * `tasks.backend_type` / `tasks.session_id` onto the linked issue when the
 * issue's breadcrumb columns are still NULL.
 *
 * Why this exists in addition to the SQL migration:
 *
 *   - Production paths that run `prisma migrate deploy` get the migration's
 *     UPDATE statements automatically and don't need this.
 *   - The Conductor `pnpm dev` / `pnpm start` paths use `prisma db push` (or
 *     skip Prisma altogether), which DO NOT replay migration files. Without
 *     this hook, every install that came up via `db push` would have its
 *     historical issues stuck at NULL forever — defeating the breadcrumb's
 *     entire purpose.
 *
 * The function is safe to run on every boot:
 *
 *   - The WHERE clauses match only rows where the breadcrumb is still NULL
 *     AND a source value actually exists, so subsequent boots with no work
 *     to do touch zero rows.
 *   - Schema-mismatch errors (P2022 / "no such column") are swallowed with a
 *     single warn so a stale schema does not block startup.
 *   - All other errors are logged but never thrown — if backfill fails for
 *     transient reasons, the next boot will retry.
 */

type RawExecutor = {
  $executeRawUnsafe: (sql: string) => Promise<number>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMissingAiSessionColumnError = (error: unknown): boolean => {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('ai_backend_type') ||
    message.includes('ai_session_id') ||
    // SQLite phrasing
    message.includes('no such column')
  );
};

const isMissingIssuesTableError = (error: unknown): boolean => {
  const message = errorMessage(error).toLowerCase();
  return (
    // SQLite
    message.includes('no such table') ||
    // Prisma
    message.includes('does not exist in the current database') ||
    message.includes('p2021')
  );
};

let warned = false;

const warnSchemaMismatch = (error: unknown): void => {
  if (warned) return;
  warned = true;
  console.warn(
    `[issue-ai-session-backfill] skipping startup backfill: schema is missing ai_backend_type / ai_session_id columns. Run 'pnpm -C web db:push' or 'prisma migrate deploy' to enable this. (${errorMessage(error)})`,
  );
};

const BACKFILL_BACKEND_SQL = `
UPDATE "issues"
SET "ai_backend_type" = (
  SELECT t."backend_type"
  FROM "tasks" t
  WHERE t."issue_id" = "issues"."id"
    AND t."backend_type" IS NOT NULL
    AND TRIM(t."backend_type") <> ''
  ORDER BY t."updated_at" DESC, t."created_at" DESC
  LIMIT 1
)
WHERE "ai_backend_type" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "tasks" t
    WHERE t."issue_id" = "issues"."id"
      AND t."backend_type" IS NOT NULL
      AND TRIM(t."backend_type") <> ''
  )
`;

const BACKFILL_SESSION_SQL = `
UPDATE "issues"
SET "ai_session_id" = (
  SELECT t."session_id"
  FROM "tasks" t
  WHERE t."issue_id" = "issues"."id"
    AND t."session_id" IS NOT NULL
    AND TRIM(t."session_id") <> ''
  ORDER BY t."updated_at" DESC, t."created_at" DESC
  LIMIT 1
)
WHERE "ai_session_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "tasks" t
    WHERE t."issue_id" = "issues"."id"
      AND t."session_id" IS NOT NULL
      AND TRIM(t."session_id") <> ''
  )
`;

export type BackfillResult = {
  attempted: boolean;
  backendUpdated: number;
  sessionUpdated: number;
  skippedReason?: 'schema-missing' | 'table-missing' | 'error';
};

/**
 * Run the idempotent backfill. Resolves with counts; never throws.
 */
export const backfillIssueAiSessionIfNeeded = async (
  client: RawExecutor = defaultDb as unknown as RawExecutor,
): Promise<BackfillResult> => {
  let backendUpdated = 0;
  try {
    backendUpdated = await client.$executeRawUnsafe(BACKFILL_BACKEND_SQL);
  } catch (error) {
    if (isMissingAiSessionColumnError(error)) {
      warnSchemaMismatch(error);
      return { attempted: true, backendUpdated: 0, sessionUpdated: 0, skippedReason: 'schema-missing' };
    }
    if (isMissingIssuesTableError(error)) {
      // Fresh install with no DB yet — let the schema sync routine take over.
      return { attempted: true, backendUpdated: 0, sessionUpdated: 0, skippedReason: 'table-missing' };
    }
    console.warn(
      `[issue-ai-session-backfill] failed to backfill ai_backend_type at startup: ${errorMessage(error)}`,
    );
    return { attempted: true, backendUpdated: 0, sessionUpdated: 0, skippedReason: 'error' };
  }

  let sessionUpdated = 0;
  try {
    sessionUpdated = await client.$executeRawUnsafe(BACKFILL_SESSION_SQL);
  } catch (error) {
    if (isMissingAiSessionColumnError(error)) {
      warnSchemaMismatch(error);
      return { attempted: true, backendUpdated, sessionUpdated: 0, skippedReason: 'schema-missing' };
    }
    if (isMissingIssuesTableError(error)) {
      return { attempted: true, backendUpdated, sessionUpdated: 0, skippedReason: 'table-missing' };
    }
    console.warn(
      `[issue-ai-session-backfill] failed to backfill ai_session_id at startup: ${errorMessage(error)}`,
    );
    return { attempted: true, backendUpdated, sessionUpdated: 0, skippedReason: 'error' };
  }

  if (backendUpdated > 0 || sessionUpdated > 0) {
    console.log(
      `[issue-ai-session-backfill] backfilled ${backendUpdated} ai_backend_type and ${sessionUpdated} ai_session_id values from existing tasks`,
    );
  }

  return { attempted: true, backendUpdated, sessionUpdated };
};
