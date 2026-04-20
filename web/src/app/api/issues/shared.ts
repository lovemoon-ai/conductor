import { z } from 'zod';
import { db } from '@/lib/db';
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

export const issueWithActiveTaskInclude = {
  tasks: {
    where: {
      status: {
        in: [...ACTIVE_ISSUE_TASK_STATUSES],
      },
    },
    orderBy: [
      { updatedAt: 'desc' as const },
      { createdAt: 'desc' as const },
    ],
    take: 1,
  },
};

export const serializeIssueWithActiveTask = (issue: {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  position: number;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
  tasks?: Array<Parameters<typeof serializeIssue>[1] extends infer T ? T extends object ? any : never : never>;
}) => serializeIssue(issue, issue.tasks?.[0] ?? null);

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
