import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

const TASK_LIST_PREFERENCES_KEY = "task-list";

export type TaskListPreferences = {
  tasksRunningOnly: boolean;
};

export const USER_PREFERENCES_SCHEMA_UNAVAILABLE_MESSAGE =
  "Task list preferences are unavailable until the database schema is updated. Run 'pnpm -C web db:push'.";

type RawPreferenceRow = {
  value: string | null;
};

const DEFAULT_TASK_LIST_PREFERENCES: TaskListPreferences = {
  tasksRunningOnly: false,
};

export class UserPreferencesSchemaUnavailableError extends Error {
  constructor() {
    super(USER_PREFERENCES_SCHEMA_UNAVAILABLE_MESSAGE);
    this.name = "UserPreferencesSchemaUnavailableError";
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorDetails = (error: unknown): string => {
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {};
  return [
    record.code,
    record.meta ? JSON.stringify(record.meta) : "",
    errorMessage(error),
  ].join(" ").toLowerCase();
};

const isMissingUserPreferencesTableError = (error: unknown): boolean => {
  const details = errorDetails(error);
  if (!details.includes("user_preferences")) {
    return false;
  }

  return (
    details.includes("p2021") ||
    details.includes("p2010") ||
    details.includes("42p01") ||
    details.includes("undefined_table") ||
    details.includes("no such table") ||
    details.includes("does not exist")
  );
};

let warnedMissingUserPreferencesSchema = false;

const warnMissingUserPreferencesSchema = (context: string, error: unknown): void => {
  if (warnedMissingUserPreferencesSchema) {
    return;
  }
  warnedMissingUserPreferencesSchema = true;
  console.warn(
    `[user-preferences] ${context}: user_preferences table is missing. ${USER_PREFERENCES_SCHEMA_UNAVAILABLE_MESSAGE} (${errorMessage(error)})`,
  );
};

const readBooleanPreference = (value: unknown): boolean | null => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
};

export const normalizeTaskListPreferences = (value: unknown): TaskListPreferences => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TASK_LIST_PREFERENCES;
  }

  const record = value as Record<string, unknown>;
  const tasksRunningOnly =
    readBooleanPreference(record.tasksRunningOnly) ??
    readBooleanPreference(record.tasks_running_only) ??
    DEFAULT_TASK_LIST_PREFERENCES.tasksRunningOnly;

  return { tasksRunningOnly };
};

const parseStoredTaskListPreferences = (value: string | null | undefined): TaskListPreferences => {
  if (!value) {
    return DEFAULT_TASK_LIST_PREFERENCES;
  }
  try {
    return normalizeTaskListPreferences(JSON.parse(value));
  } catch {
    return DEFAULT_TASK_LIST_PREFERENCES;
  }
};

export async function getTaskListPreferences(userId: string): Promise<TaskListPreferences> {
  let rows: RawPreferenceRow[];
  try {
    rows = await db.$queryRaw<RawPreferenceRow[]>`
      SELECT "value"
      FROM "user_preferences"
      WHERE "user_id" = ${userId} AND "key" = ${TASK_LIST_PREFERENCES_KEY}
      LIMIT 1
    `;
  } catch (error) {
    if (!isMissingUserPreferencesTableError(error)) {
      throw error;
    }
    warnMissingUserPreferencesSchema("task-list.get", error);
    return DEFAULT_TASK_LIST_PREFERENCES;
  }

  return parseStoredTaskListPreferences(rows[0]?.value);
}

export async function setTaskListPreferences(
  userId: string,
  preferences: TaskListPreferences,
): Promise<TaskListPreferences> {
  const normalized = normalizeTaskListPreferences(preferences);
  try {
    await db.$executeRaw`
      INSERT INTO "user_preferences" ("id", "user_id", "key", "value", "updated_at")
      VALUES (${randomUUID()}, ${userId}, ${TASK_LIST_PREFERENCES_KEY}, ${JSON.stringify(normalized)}, CURRENT_TIMESTAMP)
      ON CONFLICT ("user_id", "key") DO UPDATE SET
        "value" = excluded."value",
        "updated_at" = CURRENT_TIMESTAMP
    `;
  } catch (error) {
    if (!isMissingUserPreferencesTableError(error)) {
      throw error;
    }
    warnMissingUserPreferencesSchema("task-list.set", error);
    throw new UserPreferencesSchemaUnavailableError();
  }

  return normalized;
}
