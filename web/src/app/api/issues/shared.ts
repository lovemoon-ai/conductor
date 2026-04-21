import { z } from 'zod';
import { db } from '@/lib/db';
import { serializeTaskResponse } from '@/lib/tasks/serialization';
import { ACTIVE_ISSUE_TASK_STATUSES, coerceIssueStatus, ISSUE_STATUSES } from '@/lib/issues/config';
import { serializeIssue } from '@/lib/issues/serialization';

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

const normalizeOptionalIssueStatus = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return coerceIssueStatus(value) ?? normalizeOptionalString(value) ?? undefined;
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

const issueStatusSchema = z.enum(ISSUE_STATUSES);
const issueMetadataSchema = z.record(z.string(), z.unknown());

export const issueCreateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().nullable().optional(),
  status: issueStatusSchema.default('todo'),
  position: z.number().finite().optional(),
  metadata: issueMetadataSchema.nullable().optional(),
});

export const issuePatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  status: issueStatusSchema.optional(),
  position: z.number().finite().optional(),
  metadata: issueMetadataSchema.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'No fields to update',
});

export const normalizeIssueCreateBody = (body: unknown) => {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};

  return {
    projectId: normalizeOptionalString(readField(record, 'project_id', 'projectId')) ?? '',
    title: normalizeOptionalString(record.title) ?? '',
    description: hasOwn(record, 'description') ? normalizeOptionalString(record.description) : undefined,
    status: normalizeOptionalIssueStatus(record.status),
    position: hasOwn(record, 'position')
      ? (normalizeOptionalFiniteNumber(record.position) ?? record.position)
      : undefined,
    metadata: hasOwn(record, 'metadata')
      ? (normalizeMetadata(record.metadata) ?? record.metadata)
      : undefined,
  };
};

export const normalizeIssuePatchBody = (body: unknown) => {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};

  const normalized: Record<string, unknown> = {};
  if (hasOwn(record, 'title')) {
    normalized.title = normalizeOptionalString(record.title) ?? '';
  }
  if (hasOwn(record, 'description')) {
    normalized.description = normalizeOptionalString(record.description);
  }
  if (hasOwn(record, 'status')) {
    normalized.status = normalizeOptionalIssueStatus(record.status) ?? '';
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

export const loadIssueTaskMaps = async (userId: string, issueIds: string[]) => {
  const ids = issueIds.filter((issueId) => typeof issueId === 'string' && issueId.trim().length > 0);
  if (ids.length === 0) {
    return {
      activeTaskByIssueId: new Map<string, IssueTaskRecord>(),
      linkedTaskByIssueId: new Map<string, IssueTaskRecord>(),
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
  };
};

export const serializeIssueWithTasks = (issue: {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  position: number;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
}, tasks?: {
  activeTask?: IssueTaskRecord | null;
  linkedTask?: IssueTaskRecord | null;
}) => serializeIssue(issue, tasks?.activeTask ?? null, tasks?.linkedTask ?? null);

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
