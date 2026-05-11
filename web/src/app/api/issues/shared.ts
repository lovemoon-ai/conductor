import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { issueUserSelect, type IssueUserRecord } from '@/lib/collaboration/service';
import { serializeTaskResponse } from '@/lib/tasks/serialization';
import {
  ACTIVE_ISSUE_TASK_STATUSES,
  coerceIssuePriority,
  coerceIssueStatus,
  DEFAULT_ISSUE_PRIORITY,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  normalizeIssuePriority,
} from '@/lib/issues/config';
import { serializeIssue } from '@/lib/issues/serialization';
import { isMissingIssueAiSessionColumnError } from '@/lib/issues/persist-ai-session';

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string,
): unknown => {
  if (hasOwn(body, snakeCaseKey)) {
    return body[snakeCaseKey];
  }
  if (hasOwn(body, camelCaseKey)) {
    return body[camelCaseKey];
  }
  return undefined;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
};

const normalizeOptionalFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const normalizeOptionalBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return undefined;
};

const normalizeOptionalIssueStatus = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return coerceIssueStatus(value) ?? normalizeOptionalString(value) ?? undefined;
};

const normalizeOptionalIssuePriority = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return coerceIssuePriority(value) ?? normalizeOptionalString(value)?.toUpperCase() ?? undefined;
};

const normalizeMetadata = (value: unknown): Record<string, unknown> | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isMissingIssuePriorityColumnError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2022' &&
  (errorMessage(error).includes('issues.priority') ||
    errorMessage(error).includes('issues`.`priority') ||
    errorMessage(error).includes('`priority`') ||
    errorMessage(error).includes(' priority '));

const warnedIssuePriorityContexts = new Set<string>();

export const ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE =
  "Issue priority is unavailable until the database schema is updated. Run 'pnpm -C web db:push'.";

export const warnMissingIssuePrioritySchema = (context: string, error: unknown): void => {
  if (warnedIssuePriorityContexts.has(context)) {
    return;
  }
  warnedIssuePriorityContexts.add(context);
  console.warn(
    `[issue-priority-compat] ${context}: issues.priority column is missing, falling back to default priority behavior. ${ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE} (${errorMessage(error)})`,
  );
};

export const withIssuePrioritySchemaFallback = async <T>(
  context: string,
  run: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<{ result: T; prioritySchemaAvailable: boolean }> => {
  try {
    return {
      result: await run(),
      prioritySchemaAvailable: true,
    };
  } catch (error) {
    // The fallback select drops both `priority` and the newer
    // `ai_backend_type` / `ai_session_id` columns, so trigger it whenever
    // either set is missing — that covers partial migrations where one column
    // group is present but the other is not.
    if (
      !isMissingIssuePriorityColumnError(error) &&
      !isMissingIssueAiSessionColumnError(error)
    ) {
      throw error;
    }
    warnMissingIssuePrioritySchema(context, error);
    return {
      result: await fallback(),
      prioritySchemaAvailable: false,
    };
  }
};

// Legacy-safe select used as the fallback when newer columns are missing
// (priority, ai_backend_type, ai_session_id). Do NOT add columns introduced
// after the original `issues` table to this select — extend the WITH variant
// below instead, or routes will start failing on partially-migrated DBs.
export const issueSerializationSelect = {
  id: true,
  projectId: true,
  ownerUserId: true,
  creatorUserId: true,
  owner: {
    select: issueUserSelect,
  },
  creator: {
    select: issueUserSelect,
  },
  title: true,
  description: true,
  status: true,
  position: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IssueSelect;

// Primary select used on healthy schemas. Includes every column the API
// surfaces today; queries fall back to `issueSerializationSelect` via
// `withIssuePrioritySchemaFallback` when any of these newer columns are
// missing.
export const issueSerializationWithPrioritySelect = {
  ...issueSerializationSelect,
  priority: true,
  aiBackendType: true,
  aiSessionId: true,
} satisfies Prisma.IssueSelect;

/**
 * Variant that also pulls project name + daemon host so the response can carry
 * daemon attribution. Used when the UI displays issues from multiple projects
 * together (e.g. a merged cross-daemon group) and needs to show which daemon
 * each issue belongs to.
 */
export const issueSerializationWithProjectSelect = {
  ...issueSerializationSelect,
  project: {
    select: {
      name: true,
      daemonHost: true,
    },
  },
} satisfies Prisma.IssueSelect;

export const issueSerializationWithPriorityAndProjectSelect = {
  ...issueSerializationWithProjectSelect,
  priority: true,
} satisfies Prisma.IssueSelect;

export const isDefaultIssuePriority = (value: unknown): boolean =>
  normalizeIssuePriority(value) === DEFAULT_ISSUE_PRIORITY;

const issueStatusSchema = z.enum(ISSUE_STATUSES);
const issuePrioritySchema = z.enum(ISSUE_PRIORITIES);
const issueMetadataSchema = z.record(z.string(), z.unknown());

export const issueCreateSchema = z.object({
  projectId: z.string().min(1),
  ownerUserId: z.string().min(1).optional(),
  title: z.string().trim().min(1),
  description: z.string().trim().nullable().optional(),
  status: issueStatusSchema.default('todo'),
  priority: issuePrioritySchema.default(DEFAULT_ISSUE_PRIORITY),
  position: z.number().finite().optional(),
  metadata: issueMetadataSchema.nullable().optional(),
  includeProject: z.boolean().default(false),
  // Optional idempotency key. When supplied, the server returns the existing
  // issue (200) for a repeat `(userId, projectId, clientRequestId)` instead of
  // creating a duplicate. Stored on `metadata.clientRequestId` rather than a
  // dedicated column to keep the change additive (RFC 0025 §5.1).
  clientRequestId: z.string().trim().min(1).optional(),
});

export const issuePatchSchema = z.object({
  projectId: z.string().min(1).optional(),
  ownerUserId: z.string().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  status: issueStatusSchema.optional(),
  priority: issuePrioritySchema.optional(),
  position: z.number().finite().optional(),
  metadata: issueMetadataSchema.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'No fields to update',
});

export const normalizeIssueCreateBody = (body: unknown) => {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const includeProject = readField(record, 'include_project', 'includeProject');

  return {
    projectId: normalizeOptionalString(readField(record, 'project_id', 'projectId')) ?? '',
    ownerUserId: normalizeOptionalString(readField(record, 'owner_user_id', 'ownerUserId')) ?? undefined,
    title: normalizeOptionalString(record.title) ?? '',
    description: hasOwn(record, 'description') ? normalizeOptionalString(record.description) : undefined,
    status: normalizeOptionalIssueStatus(record.status),
    priority: normalizeOptionalIssuePriority(record.priority),
    position: hasOwn(record, 'position')
      ? (normalizeOptionalFiniteNumber(record.position) ?? record.position)
      : undefined,
    metadata: hasOwn(record, 'metadata')
      ? (normalizeMetadata(record.metadata) ?? record.metadata)
      : undefined,
    includeProject: hasOwn(record, 'include_project') || hasOwn(record, 'includeProject')
      ? (normalizeOptionalBoolean(includeProject) ?? includeProject)
      : undefined,
    clientRequestId: hasOwn(record, 'client_request_id') || hasOwn(record, 'clientRequestId')
      ? (normalizeOptionalString(readField(record, 'client_request_id', 'clientRequestId')) ?? undefined)
      : undefined,
  };
};

export const normalizeIssuePatchBody = (body: unknown) => {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};

  const normalized: Record<string, unknown> = {};
  if (hasOwn(record, 'projectId') || hasOwn(record, 'project_id')) {
    normalized.projectId = normalizeOptionalString(readField(record, 'project_id', 'projectId')) ?? '';
  }
  if (hasOwn(record, 'title')) {
    normalized.title = normalizeOptionalString(record.title) ?? '';
  }
  if (hasOwn(record, 'ownerUserId') || hasOwn(record, 'owner_user_id')) {
    normalized.ownerUserId = normalizeOptionalString(readField(record, 'owner_user_id', 'ownerUserId')) ?? '';
  }
  if (hasOwn(record, 'description')) {
    normalized.description = normalizeOptionalString(record.description);
  }
  if (hasOwn(record, 'status')) {
    normalized.status = normalizeOptionalIssueStatus(record.status) ?? '';
  }
  if (hasOwn(record, 'priority')) {
    normalized.priority = normalizeOptionalIssuePriority(record.priority) ?? '';
  }
  if (hasOwn(record, 'position')) {
    normalized.position = normalizeOptionalFiniteNumber(record.position) ?? record.position;
  }
  if (hasOwn(record, 'metadata')) {
    normalized.metadata = normalizeMetadata(record.metadata) ?? record.metadata;
  }
  return normalized;
};

export const getNextIssuePosition = async (projectId: string, status: string): Promise<number> => {
  const result = await db.issue.aggregate({
    where: {
      projectId,
      status,
    },
    _max: {
      position: true,
    },
  });

  return typeof result._max.position === 'number' && Number.isFinite(result._max.position)
    ? result._max.position + 1
    : 0;
};

type IssueTaskRecord = Parameters<typeof serializeTaskResponse>[0];

const issueTaskOrderBy = [
  { issueId: 'asc' as const },
  { updatedAt: 'desc' as const },
  { createdAt: 'desc' as const },
];

const mapFirstTaskByIssueId = (tasks: IssueTaskRecord[]) => {
  const result = new Map<string, IssueTaskRecord>();
  for (const task of tasks) {
    if (typeof task.issueId !== 'string' || result.has(task.issueId)) {
      continue;
    }
    result.set(task.issueId, task);
  }
  return result;
};

const groupTasksByIssueId = (tasks: IssueTaskRecord[]) => {
  const result = new Map<string, IssueTaskRecord[]>();
  for (const task of tasks) {
    if (typeof task.issueId !== 'string') {
      continue;
    }
    const existing = result.get(task.issueId);
    if (existing) {
      existing.push(task);
      continue;
    }
    result.set(task.issueId, [task]);
  }
  return result;
};

export const loadIssueTaskMaps = async (userId: string, issueIds: string[]) => {
  const ids = issueIds.filter((issueId) => typeof issueId === 'string' && issueId.trim().length > 0);
  if (ids.length === 0) {
    return {
      activeTaskByIssueId: new Map<string, IssueTaskRecord>(),
      linkedTaskByIssueId: new Map<string, IssueTaskRecord>(),
      tasksByIssueId: new Map<string, IssueTaskRecord[]>(),
    };
  }

  const [activeTasks, linkedTasks] = await Promise.all([
    db.task.findMany({
      where: {
        issueId: { in: ids },
        project: { userId },
        status: { in: [...ACTIVE_ISSUE_TASK_STATUSES] },
      },
      orderBy: issueTaskOrderBy,
    }),
    db.task.findMany({
      where: {
        issueId: { in: ids },
        project: { userId },
      },
      orderBy: issueTaskOrderBy,
    }),
  ]);

  return {
    activeTaskByIssueId: mapFirstTaskByIssueId(activeTasks as IssueTaskRecord[]),
    linkedTaskByIssueId: mapFirstTaskByIssueId(linkedTasks as IssueTaskRecord[]),
    tasksByIssueId: groupTasksByIssueId(linkedTasks as IssueTaskRecord[]),
  };
};

export const serializeIssueWithTasks = (issue: {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority?: string | null;
  position: number;
  metadata: string | null;
  aiBackendType?: string | null;
  aiSessionId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  ownerUserId?: string | null;
  creatorUserId?: string | null;
  owner?: IssueUserRecord | null;
  creator?: IssueUserRecord | null;
}, tasks?: {
  activeTask?: IssueTaskRecord | null;
  linkedTask?: IssueTaskRecord | null;
  tasks?: IssueTaskRecord[] | null;
}) => serializeIssue(
  issue,
  tasks?.activeTask ?? null,
  tasks?.linkedTask ?? null,
  tasks?.tasks ?? null,
);

export const buildIssueInitialContent = (issue: {
  title: string;
  description: string | null;
}): string => {
  const title = issue.title.trim();
  const description = issue.description?.trim();
  if (!description) {
    return title;
  }

  return [
    `Issue: ${title}`,
    '',
    description,
  ].join('\n');
};
