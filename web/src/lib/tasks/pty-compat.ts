import { DEFAULT_TASK_TYPE } from "./task-config";

type TaskWithLegacyFallback = {
  id: string;
  projectId: string;
  secondProjectId?: string | null;
  issueId?: string | null;
  title: string;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  backendType: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  taskType?: string | null;
  launchConfig?: unknown;
  ptySession?: unknown;
  killedReason?: string | null;
  killedAt?: Date | null;
  achievedAt?: Date | null;
};

export const legacyTaskSelect = {
  id: true,
  projectId: true,
  title: true,
  status: true,
  agentHost: true,
  executionHost: true,
  backendType: true,
  sessionId: true,
  sessionFilePath: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Task select that includes PTY/worktree columns but excludes issueId.
 * Used as an intermediate fallback when only the issue migration is missing.
 */
export const taskSelectWithoutIssueId = {
  id: true,
  projectId: true,
  title: true,
  taskType: true,
  status: true,
  agentHost: true,
  executionHost: true,
  backendType: true,
  sessionId: true,
  sessionFilePath: true,
  launchConfig: true,
  groupId: true,
  killedReason: true,
  killedAt: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

const hasErrorCode = (error: unknown, code: string): boolean =>
  (error as { code?: unknown })?.code === code;

const errorMessage = (error: unknown): string =>
  String((error as { message?: unknown })?.message || "");

const includesAny = (value: string, needles: string[]): boolean => {
  const normalized = value.toLowerCase();
  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
};

const isMissingPtySessionTableError = (error: unknown): boolean =>
  hasErrorCode(error, "P2021") && includesAny(errorMessage(error), ["pty_sessions", "ptysession"]);

const isMissingTaskTypeColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") && includesAny(errorMessage(error), ["task_type", "taskType"]);

const isMissingLaunchConfigColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") && includesAny(errorMessage(error), ["launch_config", "launchConfig"]);

const isMissingIssueIdColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") && includesAny(errorMessage(error), ["issue_id", "issueId"]);

const isMissingKilledStateColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") &&
  includesAny(errorMessage(error), ["killed_reason", "killedReason", "killed_at", "killedAt"]);

const isMissingAchievedAtColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") &&
  includesAny(errorMessage(error), ["achieved_at", "achievedAt"]);

export const isMissingGroupIdColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") &&
  includesAny(errorMessage(error), ["group_id", "groupId"]);

/**
 * True when the error is caused by a missing `second_project_id` column (a
 * display-only field added after earlier migrations). Reads that only SELECT
 * the column recover through the legacy-shape fallback; the task-list query,
 * which also references it in its WHERE clause, degrades to a plain projectId
 * filter (see `findTasksForList`).
 */
export const isMissingSecondProjectIdColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") &&
  includesAny(errorMessage(error), ["second_project_id", "secondProjectId"]);

/**
 * Returns true when task fields required by the current runtime are missing.
 * This historically handled PTY fields; killed-state fields join the same
 * legacy-shape fallback so rolling deployment can read pre-migration rows.
 * Missing issue_id is NOT included — it has its own fallback path.
 */
export const isMissingPtySchemaError = (error: unknown): boolean =>
  isMissingPtySessionTableError(error) ||
  isMissingTaskTypeColumnError(error) ||
  isMissingLaunchConfigColumnError(error) ||
  isMissingKilledStateColumnError(error) ||
  isMissingAchievedAtColumnError(error) ||
  isMissingGroupIdColumnError(error) ||
  isMissingSecondProjectIdColumnError(error);

/**
 * Returns true when the error is caused by a missing issue_id column only.
 */
export const isMissingIssueIdSchemaError = (error: unknown): boolean =>
  isMissingIssueIdColumnError(error);

/**
 * Returns true for any newer column that is missing (PTY or issue_id).
 * Useful for catch-all guards in DELETE paths and similar non-critical contexts.
 */
export const isMissingAnyNewSchemaError = (error: unknown): boolean =>
  isMissingPtySchemaError(error) || isMissingIssueIdSchemaError(error);

const warnedContexts = new Set<string>();

const warnMissingPtySchema = (context: string, error: unknown): void => {
  if (warnedContexts.has(context)) return;
  warnedContexts.add(context);
  const errorDetail = error instanceof Error ? error.message : String(error);
  console.warn(
    `[pty-compat] ${context}: task schema is missing newer columns, falling back to legacy task behavior. Run 'pnpm -C web db:push' to enable PTY tasks and issue-linked tasks. (${errorDetail})`,
  );
};

const warnMissingIssueIdSchema = (context: string, error: unknown): void => {
  if (warnedContexts.has(context)) return;
  warnedContexts.add(context);
  const errorDetail = error instanceof Error ? error.message : String(error);
  console.warn(
    `[pty-compat] ${context}: issue_id column is missing, falling back to task shape without issueId. Run 'pnpm -C web db:push' to enable issue-linked tasks. (${errorDetail})`,
  );
};

/**
 * Three-tier fallback:
 *  1. run()                         — full schema (PTY + issueId)
 *  2. issueIdFallback()             — PTY columns present, issueId missing
 *  3. legacyFallback()              — genuinely missing PTY/task columns
 *
 * If issueIdFallback is not provided, missing issueId falls through to
 * legacyFallback for backward compatibility.
 */
export async function withPtySchemaFallback<T>(
  context: string,
  run: () => Promise<T>,
  legacyFallback: () => Promise<T>,
  issueIdFallback?: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isMissingIssueIdSchemaError(error) && issueIdFallback) {
      warnMissingIssueIdSchema(context, error);
      return issueIdFallback();
    }
    if (!isMissingPtySchemaError(error) && !isMissingIssueIdSchemaError(error)) {
      throw error;
    }
    warnMissingPtySchema(context, error);
    return legacyFallback();
  }
}

export const applyLegacyTaskShape = <T extends TaskWithLegacyFallback | null>(
  task: T,
): T extends null
  ? null
  : T & {
      secondProjectId: null;
      taskType: string;
      launchConfig: null;
      ptySession: null;
      killedReason: null;
      killedAt: null;
      achievedAt: null;
      groupId: null;
    } => {
  if (!task) {
    return null as T extends null
      ? null
      : T & {
          secondProjectId: null;
          taskType: string;
          launchConfig: null;
          ptySession: null;
          killedReason: null;
          killedAt: null;
          achievedAt: null;
          groupId: null;
        };
  }
  return {
    ...task,
    // `second_project_id` is a display-only column added after the legacy
    // fallback selects; degraded schemas never carry it, so force null (same
    // strategy as `issueId`) rather than SELECTing a possibly-missing column.
    secondProjectId: null,
    issueId: task.issueId ?? null,
    taskType: DEFAULT_TASK_TYPE,
    launchConfig: null,
    ptySession: null,
    killedReason: null,
    killedAt: null,
    achievedAt: null,
    groupId: null,
  } as T extends null
    ? null
    : T & {
        secondProjectId: null;
        taskType: string;
        launchConfig: null;
        ptySession: null;
        killedReason: null;
        killedAt: null;
        achievedAt: null;
        groupId: null;
      };
};

export const PTY_SCHEMA_UNAVAILABLE_MESSAGE =
  "PTY tasks are unavailable until the database schema is updated. Run 'pnpm -C web db:push'.";
