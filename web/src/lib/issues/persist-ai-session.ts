import { Prisma } from '@prisma/client';

/**
 * Persists the AI backend type and session id of a task onto its associated
 * issue so the breadcrumb survives task deletion or unlinking. Only writes
 * non-empty values — passing `null`/empty strings is a no-op so a freshly
 * created task without a session id can never wipe a previously captured one.
 */

type IssueWriter = {
  issue: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
};

const errorMessage = (error: unknown): string =>
  String((error as { message?: unknown })?.message || '');

const includesAny = (value: string, needles: string[]): boolean => {
  const normalized = value.toLowerCase();
  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
};

export const isMissingIssueAiSessionColumnError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2022' &&
  includesAny(errorMessage(error), [
    'ai_backend_type',
    'aiBackendType',
    'ai_session_id',
    'aiSessionId',
  ]);

const warnedContexts = new Set<string>();

const warnMissingIssueAiSessionSchema = (error: unknown): void => {
  const context = 'issues.persist_ai_session';
  if (warnedContexts.has(context)) return;
  warnedContexts.add(context);
  console.warn(
    `[issue-ai-session] ${context}: ai_backend_type/ai_session_id columns are missing on issues. Run 'pnpm -C web db:push' to enable AI session breadcrumbs. (${errorMessage(error)})`,
  );
};

const normalize = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * Mirror the latest non-empty AI backend type / session id from a task onto
 * the related issue. If both inputs are empty there is nothing to persist.
 *
 * The write is best-effort: if the issue table predates this feature
 * (`P2022`) we warn once and swallow the error so AI task creation keeps
 * working until the migration is applied.
 */
export const persistIssueAiSession = async (
  tx: IssueWriter,
  issueId: string | null | undefined,
  patch: { backendType?: string | null; sessionId?: string | null },
): Promise<void> => {
  const targetIssueId = normalize(issueId);
  if (!targetIssueId) return;

  const data: Record<string, string> = {};
  const backendType = normalize(patch.backendType);
  const sessionId = normalize(patch.sessionId);
  if (backendType) data.aiBackendType = backendType;
  if (sessionId) data.aiSessionId = sessionId;
  if (Object.keys(data).length === 0) return;

  try {
    await tx.issue.update({
      where: { id: targetIssueId },
      data,
    });
  } catch (error) {
    if (isMissingIssueAiSessionColumnError(error)) {
      warnMissingIssueAiSessionSchema(error);
      return;
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    ) {
      // Issue was deleted concurrently — nothing to update.
      return;
    }
    throw error;
  }
};
