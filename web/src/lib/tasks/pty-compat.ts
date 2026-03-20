import { DEFAULT_TASK_TYPE } from "./task-config";

type TaskWithLegacyFallback = {
  id: string;
  projectId: string;
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

const hasErrorCode = (error: unknown, code: string): boolean =>
  (error as { code?: unknown })?.code === code;

const errorMessage = (error: unknown): string =>
  String((error as { message?: unknown })?.message || "");

const includesAny = (value: string, needles: string[]): boolean => {
  const normalized = value.toLowerCase();
  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
};

export const isMissingPtySessionTableError = (error: unknown): boolean =>
  hasErrorCode(error, "P2021") && includesAny(errorMessage(error), ["pty_sessions", "ptysession"]);

export const isMissingTaskTypeColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") && includesAny(errorMessage(error), ["task_type", "taskType"]);

export const isMissingLaunchConfigColumnError = (error: unknown): boolean =>
  hasErrorCode(error, "P2022") && includesAny(errorMessage(error), ["launch_config", "launchConfig"]);

export const isMissingPtySchemaError = (error: unknown): boolean =>
  isMissingPtySessionTableError(error) ||
  isMissingTaskTypeColumnError(error) ||
  isMissingLaunchConfigColumnError(error);

const warnedContexts = new Set<string>();

export const warnMissingPtySchema = (context: string, error: unknown): void => {
  if (warnedContexts.has(context)) return;
  warnedContexts.add(context);
  console.warn(
    `[pty-compat] ${context}: PTY schema missing, falling back to legacy task behavior. Run 'pnpm -C web db:push' to enable PTY tasks. (${
      error instanceof Error ? error.message : String(error)
    })`,
  );
};

export async function withPtySchemaFallback<T>(
  context: string,
  run: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isMissingPtySchemaError(error)) {
      throw error;
    }
    warnMissingPtySchema(context, error);
    return fallback();
  }
}

export const applyLegacyTaskShape = <T extends TaskWithLegacyFallback | null>(
  task: T,
): T extends null ? null : T & { taskType: string; launchConfig: null; ptySession: null } => {
  if (!task) {
    return null as T extends null ? null : T & { taskType: string; launchConfig: null; ptySession: null };
  }
  return {
    ...task,
    taskType: DEFAULT_TASK_TYPE,
    launchConfig: null,
    ptySession: null,
  } as T extends null ? null : T & { taskType: string; launchConfig: null; ptySession: null };
};

export const PTY_SCHEMA_UNAVAILABLE_MESSAGE =
  "PTY tasks are unavailable until the database schema is updated. Run 'pnpm -C web db:push'.";
