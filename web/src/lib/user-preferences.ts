import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  consolidateSyncedTaskCardGroups,
  LIST_CARD_GROUPS_SCOPE,
  MAX_SYNCED_TASK_CARD_SCOPES,
  mergeTaskIntoSourceCardGroup,
  readSyncedTaskCardGroups,
  setTaskCardTabLabel,
  readTaskCardGroupsSyncSnapshot,
  toSyncedTaskCardGroups,
  type SyncedTaskCardGroup,
  type TaskCardGroupsSyncSnapshot,
} from "@/features/tasks/utils/task-card-groups";
import {
  MAX_SYNCED_PROJECT_CARD_SCOPES,
  readProjectCardGroupsSyncSnapshot,
  readSyncedProjectCardGroups,
  type ProjectCardGroupsSyncSnapshot,
  type SyncedProjectCardGroup,
} from "@/features/projects/utils/project-card-groups";

const TASK_LIST_PREFERENCES_KEY = "task-list";
const TASK_CARD_GROUPS_PREFERENCES_KEY = "task-card-groups:v1";
const TASK_CARD_GROUPS_WRITE_RETRIES = 4;
const PROJECT_CARD_GROUPS_PREFERENCES_KEY = "project-card-groups:v1";
const PROJECT_CARD_GROUPS_WRITE_RETRIES = 4;

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

export class ProjectCardGroupsPreferencesConflictError extends Error {
  constructor() {
    super("Project card groups changed on another device. Please try again.");
    this.name = "ProjectCardGroupsPreferencesConflictError";
  }
}

export class ProjectCardGroupsPreferencesUnavailableError extends Error {
  constructor() {
    super("Project card group sync is unavailable until the user preferences schema is updated.");
    this.name = "ProjectCardGroupsPreferencesUnavailableError";
  }
}

export class ProjectCardGroupsPreferencesLimitError extends Error {
  constructor() {
    super(`Project card groups support at most ${MAX_SYNCED_PROJECT_CARD_SCOPES} scopes.`);
    this.name = "ProjectCardGroupsPreferencesLimitError";
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
 * Collapse every legacy per-project scope into the single global list-card
 * scope, in one atomic rewrite. Tab cards are global (see LIST_CARD_GROUPS_SCOPE)
 * so the per-project scopes are dead weight after the client migration: they
 * count toward MAX_SYNCED_TASK_CARD_SCOPES and get re-folded on every load.
 * Folding them into the global scope and dropping the old keys bounds the
 * stored payload to one scope and removes the cruft.
 *
 * Idempotent: when only the global scope (or nothing) is present there is
 * nothing to collapse and the stored value is left untouched. Runs lazily on
 * read so it needs no separate migration endpoint; the union it produces is the
 * same one the client renders, so read and storage always agree.
 */
export async function consolidateTaskCardGroupsScopes(
  userId: string,
): Promise<TaskCardGroupsSyncSnapshot> {
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
      warnMissingUserPreferencesSchema("task-card-groups.consolidate", error);
      return readTaskCardGroupsSyncSnapshot(null);
    }

    const previousRaw = rows[0]?.value;
    const current = parseStoredTaskCardGroupsSnapshot(previousRaw);
    const legacyScopes = Object.keys(current.scopes).filter(
      (scope) => scope !== LIST_CARD_GROUPS_SCOPE,
    );
    // Nothing stored, or already a single global scope → no rewrite needed.
    if (previousRaw === undefined || legacyScopes.length === 0) return current;

    const union = consolidateSyncedTaskCardGroups([
      current.scopes[LIST_CARD_GROUPS_SCOPE] ?? [],
      ...legacyScopes.map((scope) => current.scopes[scope]),
    ]);
    const next = readTaskCardGroupsSyncSnapshot({
      version: 1,
      revision: current.revision + 1,
      scopes: union.length > 0 ? { [LIST_CARD_GROUPS_SCOPE]: union } : {},
    });
    const nextRaw = JSON.stringify(next);

    try {
      const changed = await db.$executeRaw`
        UPDATE "user_preferences"
        SET "value" = ${nextRaw}, "updated_at" = CURRENT_TIMESTAMP
        WHERE "user_id" = ${userId}
          AND "key" = ${TASK_CARD_GROUPS_PREFERENCES_KEY}
          AND "value" = ${previousRaw}
      `;
      if (Number(changed) > 0) return next;
    } catch (error) {
      if (!isMissingUserPreferencesTableError(error)) throw error;
      warnMissingUserPreferencesSchema("task-card-groups.consolidate", error);
      return current;
    }
    // Lost the compare-and-set race; re-read and retry.
  }

  // Persisting the collapse kept losing the race — return the freshest read so
  // the caller still gets a coherent (un-collapsed) snapshot rather than erroring.
  return getTaskCardGroupsPreferences(userId);
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

/**
 * Atomically group a newly-created related task beside its source task.
 *
 * The task list now has one global grouping scope, but older installations can
 * still hold per-project scopes. Fold those scopes before applying the merge so
 * a source task keeps its existing tab-card membership during the lazy
 * migration. Compare-and-set retries prevent a concurrent drag/drop edit from
 * being overwritten by related-task creation.
 */
export async function mergeRelatedTaskCardGroup(
  userId: string,
  sourceTaskId: string,
  relatedTaskId: string,
  /**
   * Optional tab titles for the two members. Without them a tab falls back to
   * its ordinal ("1", "2", …) — see `taskCardTabLabel`. Multi-agent groups pass
   * the agent names so the strip reads "feature-dev | code-reviewer" instead of
   * "1 | 2". Users can still rename a tab by long-pressing it.
   */
  labels?: { source?: string | null; related?: string | null },
): Promise<TaskCardGroupsSyncSnapshot> {
  const normalizedSourceTaskId = sourceTaskId.trim();
  const normalizedRelatedTaskId = relatedTaskId.trim();
  if (!normalizedSourceTaskId || !normalizedRelatedTaskId) {
    throw new Error("Task card grouping requires source and related task ids.");
  }

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
      warnMissingUserPreferencesSchema("task-card-groups.merge-successor", error);
      throw new TaskCardGroupsPreferencesUnavailableError();
    }

    const previousRaw = rows[0]?.value;
    const current = parseStoredTaskCardGroupsSnapshot(previousRaw);
    const legacyScopes = Object.keys(current.scopes).filter(
      (scope) => scope !== LIST_CARD_GROUPS_SCOPE,
    );
    const consolidated = consolidateSyncedTaskCardGroups([
      current.scopes[LIST_CARD_GROUPS_SCOPE] ?? [],
      ...legacyScopes.map((scope) => current.scopes[scope]),
    ]);
    const localGroups = consolidated.map((group) => ({
      ...group,
      activeIndex: 0,
    }));
    let merged = mergeTaskIntoSourceCardGroup(
      localGroups,
      `tabcard-branch-${randomUUID()}`,
      normalizedSourceTaskId,
      normalizedRelatedTaskId,
    );
    const mergedGroupId = merged.find((group) =>
      group.taskIds.includes(normalizedSourceTaskId)
      && group.taskIds.includes(normalizedRelatedTaskId)
    )?.id;
    if (mergedGroupId) {
      // Applied after the merge because the group id is only known here — a
      // brand new card gets a fresh `tabcard-branch-*` id, while merging into
      // an existing card reuses that card's id.
      const sourceLabel = labels?.source?.trim();
      const relatedLabel = labels?.related?.trim();
      if (sourceLabel) {
        merged = setTaskCardTabLabel(merged, mergedGroupId, normalizedSourceTaskId, sourceLabel);
      }
      if (relatedLabel) {
        merged = setTaskCardTabLabel(merged, mergedGroupId, normalizedRelatedTaskId, relatedLabel);
      }
    }
    const mergedGroups = toSyncedTaskCardGroups(merged);
    if (!mergedGroups.some((group) =>
      group.taskIds.includes(normalizedSourceTaskId)
      && group.taskIds.includes(normalizedRelatedTaskId)
    )) {
      throw new Error("Task card group limits prevent grouping the related task.");
    }

    // Another writer may have completed the same idempotent merge while this
    // request was retrying. Avoid an unnecessary revision bump in that case.
    if (
      legacyScopes.length === 0
      && JSON.stringify(mergedGroups)
        === JSON.stringify(current.scopes[LIST_CARD_GROUPS_SCOPE] ?? [])
    ) {
      return current;
    }

    const next = readTaskCardGroupsSyncSnapshot({
      version: 1,
      revision: current.revision + 1,
      scopes: {
        [LIST_CARD_GROUPS_SCOPE]: mergedGroups,
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
      warnMissingUserPreferencesSchema("task-card-groups.merge-successor", error);
      throw new TaskCardGroupsPreferencesUnavailableError();
    }
  }

  throw new TaskCardGroupsPreferencesConflictError();
}

export const mergeSuccessorTaskCardGroup = mergeRelatedTaskCardGroup;

const parseStoredProjectCardGroupsSnapshot = (
  value: string | null | undefined,
): ProjectCardGroupsSyncSnapshot => {
  if (!value) return readProjectCardGroupsSyncSnapshot(null);
  try {
    return readProjectCardGroupsSyncSnapshot(JSON.parse(value));
  } catch {
    return readProjectCardGroupsSyncSnapshot(null);
  }
};

export async function getProjectCardGroupsPreferences(
  userId: string,
): Promise<ProjectCardGroupsSyncSnapshot> {
  let rows: RawPreferenceRow[];
  try {
    rows = await db.$queryRaw<RawPreferenceRow[]>`
      SELECT "value"
      FROM "user_preferences"
      WHERE "user_id" = ${userId} AND "key" = ${PROJECT_CARD_GROUPS_PREFERENCES_KEY}
      LIMIT 1
    `;
  } catch (error) {
    if (!isMissingUserPreferencesTableError(error)) throw error;
    warnMissingUserPreferencesSchema("project-card-groups.get", error);
    return readProjectCardGroupsSyncSnapshot(null);
  }

  return parseStoredProjectCardGroupsSnapshot(rows[0]?.value);
}

/**
 * Atomically replace one aggregation scope. Comparing the previous serialized
 * value makes concurrent writers retry against the newest snapshot. Concurrent
 * edits to the same scope use intentional last-writer-wins semantics.
 */
export async function setProjectCardGroupsScope(
  userId: string,
  scope: string,
  groups: SyncedProjectCardGroup[],
): Promise<ProjectCardGroupsSyncSnapshot> {
  const normalizedGroups = readSyncedProjectCardGroups(groups);

  for (let attempt = 0; attempt < PROJECT_CARD_GROUPS_WRITE_RETRIES; attempt += 1) {
    let rows: RawPreferenceRow[];
    try {
      rows = await db.$queryRaw<RawPreferenceRow[]>`
        SELECT "value"
        FROM "user_preferences"
        WHERE "user_id" = ${userId} AND "key" = ${PROJECT_CARD_GROUPS_PREFERENCES_KEY}
        LIMIT 1
      `;
    } catch (error) {
      if (!isMissingUserPreferencesTableError(error)) throw error;
      warnMissingUserPreferencesSchema("project-card-groups.set", error);
      throw new ProjectCardGroupsPreferencesUnavailableError();
    }

    const previousRaw = rows[0]?.value;
    const current = parseStoredProjectCardGroupsSnapshot(previousRaw);
    if (
      !Object.prototype.hasOwnProperty.call(current.scopes, scope)
      && Object.keys(current.scopes).length >= MAX_SYNCED_PROJECT_CARD_SCOPES
    ) {
      throw new ProjectCardGroupsPreferencesLimitError();
    }

    const next = readProjectCardGroupsSyncSnapshot({
      version: 1,
      revision: current.revision + 1,
      scopes: {
        ...current.scopes,
        // Keep [] as an authoritative tombstone so another device cannot
        // resurrect a locally cached aggregation after the user dissolves it.
        [scope]: normalizedGroups,
      },
    });
    const nextRaw = JSON.stringify(next);

    try {
      const changed = previousRaw === undefined
        ? await db.$executeRaw`
            INSERT INTO "user_preferences" ("id", "user_id", "key", "value", "updated_at")
            VALUES (${randomUUID()}, ${userId}, ${PROJECT_CARD_GROUPS_PREFERENCES_KEY}, ${nextRaw}, CURRENT_TIMESTAMP)
            ON CONFLICT ("user_id", "key") DO NOTHING
          `
        : await db.$executeRaw`
            UPDATE "user_preferences"
            SET "value" = ${nextRaw}, "updated_at" = CURRENT_TIMESTAMP
            WHERE "user_id" = ${userId}
              AND "key" = ${PROJECT_CARD_GROUPS_PREFERENCES_KEY}
              AND "value" = ${previousRaw}
          `;
      if (Number(changed) > 0) return next;
    } catch (error) {
      if (!isMissingUserPreferencesTableError(error)) throw error;
      warnMissingUserPreferencesSchema("project-card-groups.set", error);
      throw new ProjectCardGroupsPreferencesUnavailableError();
    }
  }

  throw new ProjectCardGroupsPreferencesConflictError();
}
