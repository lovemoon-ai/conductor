import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  MAX_SYNCED_TASK_CARD_SCOPES,
  readSyncedTaskCardGroups,
  readTaskCardGroupsSyncSnapshot,
  type SyncedTaskCardGroup,
  type TaskCardGroupsSyncSnapshot,
} from "@/features/tasks/utils/task-card-groups";

const TASK_LIST_PREFERENCES_KEY = "task-list";
const TASK_CARD_GROUPS_PREFERENCES_KEY = "task-card-groups:v1";
const TASK_CARD_GROUPS_WRITE_RETRIES = 4;

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

export class TaskCardGroupsPreferencesConflictError extends Error {
  constructor() {
    super("Task card groups changed on another device. Please try again.");
    this.name = "TaskCardGroupsPreferencesConflictError";
  }
}

export class TaskCardGroupsPreferencesUnavailableError extends Error {
  constructor() {
    super("Task card group sync is unavailable until the user preferences schema is updated.");
    this.name = "TaskCardGroupsPreferencesUnavailableError";
  }
}

export class TaskCardGroupsPreferencesLimitError extends Error {
  constructor() {
    super(`Task card groups support at most ${MAX_SYNCED_TASK_CARD_SCOPES} project scopes.`);
    this.name = "TaskCardGroupsPreferencesLimitError";
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
  const unavailableMessage = context.startsWith("task-card-groups")
    ? "Task card group sync is unavailable until the database schema is updated."
    : USER_PREFERENCES_SCHEMA_UNAVAILABLE_MESSAGE;
  console.warn(
    `[user-preferences] ${context}: user_preferences table is missing. ${unavailableMessage} (${errorMessage(error)})`,
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

const parseStoredTaskCardGroupsSnapshot = (
  value: string | null | undefined,
): TaskCardGroupsSyncSnapshot => {
  if (!value) return readTaskCardGroupsSyncSnapshot(null);
  try {
    return readTaskCardGroupsSyncSnapshot(JSON.parse(value));
  } catch {
    return readTaskCardGroupsSyncSnapshot(null);
  }
};

export async function getTaskCardGroupsPreferences(
  userId: string,
): Promise<TaskCardGroupsSyncSnapshot> {
  let rows: RawPreferenceRow[];
  try {
    rows = await db.$queryRaw<RawPreferenceRow[]>`
      SELECT "value"
      FROM "user_preferences"
      WHERE "user_id" = ${userId} AND "key" = ${TASK_CARD_GROUPS_PREFERENCES_KEY}
      LIMIT 1
    `;
  } catch (error) {
    if (!isMissingUserPreferencesTableError(error)) throw error;
    warnMissingUserPreferencesSchema("task-card-groups.get", error);
    return readTaskCardGroupsSyncSnapshot(null);
  }

  return parseStoredTaskCardGroupsSnapshot(rows[0]?.value);
}

/**
 * Atomically replace one project scope. Comparing the previous serialized
 * value makes concurrent writers retry against the newest snapshot, so writes
 * to different scopes are not lost. Concurrent edits to the same scope use
 * intentional last-writer-wins semantics.
 */
export async function setTaskCardGroupsScope(
  userId: string,
  scope: string,
  groups: SyncedTaskCardGroup[],
): Promise<TaskCardGroupsSyncSnapshot> {
  const normalizedGroups = readSyncedTaskCardGroups(groups);

  for (let attempt = 0; attempt < TASK_CARD_GROUPS_WRITE_RETRIES; attempt += 1) {
    let rows: RawPreferenceRow[];
    try {
      rows = await db.$queryRaw<RawPreferenceRow[]>`
        SELECT "value"
        FROM "user_preferences"
        WHERE "user_id" = ${userId} AND "key" = ${TASK_CARD_GROUPS_PREFERENCES_KEY}
        LIMIT 1
      `;
    } catch (error) {
      if (!isMissingUserPreferencesTableError(error)) throw error;
      warnMissingUserPreferencesSchema("task-card-groups.set", error);
      throw new TaskCardGroupsPreferencesUnavailableError();
    }

    const previousRaw = rows[0]?.value;
    const current = parseStoredTaskCardGroupsSnapshot(previousRaw);
    if (
      !Object.prototype.hasOwnProperty.call(current.scopes, scope)
      && Object.keys(current.scopes).length >= MAX_SYNCED_TASK_CARD_SCOPES
    ) {
      throw new TaskCardGroupsPreferencesLimitError();
    }

    const next = readTaskCardGroupsSyncSnapshot({
      version: 1,
      revision: current.revision + 1,
      scopes: {
        ...current.scopes,
        // Keep [] as an authoritative tombstone so another device cannot
        // resurrect a locally cached group after the user dissolves it.
        [scope]: normalizedGroups,
      },
    });
    const nextRaw = JSON.stringify(next);

    try {
      const changed = previousRaw === undefined
        ? await db.$executeRaw`
            INSERT INTO "user_preferences" ("id", "user_id", "key", "value", "updated_at")
            VALUES (${randomUUID()}, ${userId}, ${TASK_CARD_GROUPS_PREFERENCES_KEY}, ${nextRaw}, CURRENT_TIMESTAMP)
            ON CONFLICT ("user_id", "key") DO NOTHING
          `
        : await db.$executeRaw`
            UPDATE "user_preferences"
            SET "value" = ${nextRaw}, "updated_at" = CURRENT_TIMESTAMP
            WHERE "user_id" = ${userId}
              AND "key" = ${TASK_CARD_GROUPS_PREFERENCES_KEY}
              AND "value" = ${previousRaw}
          `;
      if (Number(changed) > 0) return next;
    } catch (error) {
      if (!isMissingUserPreferencesTableError(error)) throw error;
      warnMissingUserPreferencesSchema("task-card-groups.set", error);
      throw new TaskCardGroupsPreferencesUnavailableError();
    }
  }

  throw new TaskCardGroupsPreferencesConflictError();
}
