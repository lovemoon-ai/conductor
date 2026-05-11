import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime/hub';
import {
  getNextIssuePosition,
  ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE,
  isDefaultIssuePriority,
  issueCreateSchema,
  issueSerializationSelect,
  issueSerializationWithPrioritySelect,
  issueSerializationWithProjectSelect,
  issueSerializationWithPriorityAndProjectSelect,
  isMissingIssuePriorityColumnError,
  loadIssueTaskMaps,
  normalizeIssueCreateBody,
  serializeIssueWithTasks,
  warnMissingIssuePrioritySchema,
  withIssuePrioritySchemaFallback,
} from './shared';
import { parseIssueMetadata } from '@/lib/issues/serialization';
import { stripTopLevelAuditKeys } from '@/lib/audit/metadata';

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('project_id')?.trim() || null;
  // `project_ids` lets the UI fetch issues across multiple projects in one
  // call — used by the cross-daemon merged-project view to show issues from
  // each daemon's same-named project together while preserving daemon
  // attribution.
  const rawProjectIds = searchParams.get('project_ids');
  const projectIds = rawProjectIds
    ? rawProjectIds
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  if (projectId && projectIds.length > 0) {
    return NextResponse.json(
      { error: 'Specify either project_id or project_ids, not both' },
      { status: 400 },
    );
  }

  const projectFilter = projectIds.length > 0
    ? { projectId: { in: projectIds } }
    : projectId
      ? { projectId }
      : {};

  const listQuery = {
    where: {
      project: { userId: user.id },
      ...projectFilter,
    },
    orderBy: [
      { status: 'asc' as const },
      { position: 'asc' as const },
      { updatedAt: 'desc' as const },
    ],
  };

  // Only pull the project join when the caller is in a cross-daemon merged
  // view (`project_ids` set). Single-project and full-list views skip the
  // JOIN to keep the high-traffic path cheap.
  const includeProjectJoin = projectIds.length > 0;
  const { result: issues } = await withIssuePrioritySchemaFallback(
    'issues.list',
    () => db.issue.findMany({
      ...listQuery,
      select: includeProjectJoin
        ? issueSerializationWithPriorityAndProjectSelect
        : issueSerializationWithPrioritySelect,
    }),
    () => db.issue.findMany({
      ...listQuery,
      select: includeProjectJoin
        ? issueSerializationWithProjectSelect
        : issueSerializationSelect,
    }),
  );

  const { activeTaskByIssueId, linkedTaskByIssueId, tasksByIssueId } = await loadIssueTaskMaps(
    user.id,
    issues.map((issue: { id: string }) => issue.id),
  );

  return NextResponse.json(issues.map((issue: {
    id: string;
    projectId: string;
    title: string;
    description: string | null;
    status: string;
    priority?: string | null;
    position: number;
    metadata: string | null;
    createdAt: Date;
    updatedAt: Date;
    project?: { name: string | null; daemonHost: string | null } | null;
  }) => serializeIssueWithTasks(issue, {
    activeTask: activeTaskByIssueId.get(issue.id) ?? null,
    linkedTask: linkedTaskByIssueId.get(issue.id) ?? null,
    tasks: tasksByIssueId.get(issue.id) ?? null,
  })));
}

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const body = await request.json().catch(() => null);
  const parsed = issueCreateSchema.safeParse(normalizeIssueCreateBody(body));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const project = await db.project.findFirst({
    where: {
      id: input.projectId,
      userId: user.id,
    },
    select: { id: true },
  });

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Merge clientRequestId into metadata so the idempotency key is persisted
  // alongside the structured `metadata.audit.*` object (RFC 0025 §5.1 / §5.2).
  // We strip any top-level audit keys a caller might inject (review M3) so
  // they can't masquerade as authoritative audit info.
  const baseMetadata = stripTopLevelAuditKeys(input.metadata ?? null);
  const mergedMetadata: Record<string, unknown> | null = input.clientRequestId
    ? { ...(baseMetadata ?? {}), clientRequestId: input.clientRequestId }
    : baseMetadata;

  // Idempotency lookup: scoped by `(userId via project, projectId,
  // metadata.clientRequestId)`. Select-then-filter because `metadata` is a
  // JSON-encoded TEXT column without a JSON-path unique index — keeps the
  // change cross-DB-portable per RFC §5.1.
  //
  // Race window (review H2): two concurrent POSTs with the same
  // `clientRequestId` can both pass this lookup before either persists, then
  // both create separate issues + both broadcast. We accept this as a
  // documented trade-off here; eliminating it requires either a partial
  // unique index on `(projectId, metadata->>'clientRequestId')` (Postgres) or
  // promoting `clientRequestId` to a real column. The RFC names this
  // follow-up; CLI usage today is single-threaded per (user, request id) so
  // observed collisions should be rare.
  if (input.clientRequestId) {
    const candidates = await db.issue.findMany({
      where: {
        projectId: input.projectId,
        project: { userId: user.id },
      },
      // Newest first so a retried request quickly finds its prior write.
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: input.includeProject
        ? issueSerializationWithPriorityAndProjectSelect
        : issueSerializationWithPrioritySelect,
    }).catch(async (error) => {
      if (!isMissingIssuePriorityColumnError(error)) throw error;
      warnMissingIssuePrioritySchema('issues.create.idempotency-lookup', error);
      return db.issue.findMany({
        where: {
          projectId: input.projectId,
          project: { userId: user.id },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: input.includeProject
          ? issueSerializationWithProjectSelect
          : issueSerializationSelect,
      });
    });

    const existing = candidates.find((row: { metadata: string | null }) => {
      const parsed = parseIssueMetadata(row.metadata);
      return parsed && parsed.clientRequestId === input.clientRequestId;
    });
    if (existing) {
      // Idempotent re-fetch — do NOT broadcast, do NOT re-create.
      return NextResponse.json(serializeIssueWithTasks(existing));
    }
  }

  const position = typeof input.position === 'number'
    ? input.position
    : await getNextIssuePosition(input.projectId, input.status);

  const issueData = {
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    priority: input.priority,
    position,
    metadata: mergedMetadata ? JSON.stringify(mergedMetadata) : null,
  };

  let issue;
  try {
    issue = await db.issue.create({
      data: issueData,
      select: input.includeProject
        ? issueSerializationWithPriorityAndProjectSelect
        : issueSerializationWithPrioritySelect,
    });
  } catch (error) {
    if (!isMissingIssuePriorityColumnError(error)) {
      throw error;
    }
    if (!isDefaultIssuePriority(input.priority)) {
      return NextResponse.json(
        { error: ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE },
        { status: 409 },
      );
    }
    warnMissingIssuePrioritySchema('issues.create', error);
    issue = await db.issue.create({
      data: {
        projectId: issueData.projectId,
        title: issueData.title,
        description: issueData.description,
        status: issueData.status,
        position: issueData.position,
        metadata: issueData.metadata,
      },
      select: input.includeProject
        ? issueSerializationWithProjectSelect
        : issueSerializationSelect,
    });
  }

  const serialized = serializeIssueWithTasks(issue);

  // Broadcast `issue.created` over the same per-user app WebSocket the issue
  // store already subscribes to. RFC 0025 §5.3 — payload mirrors the POST
  // response so the frontend can merge it into local state without a refetch.
  // Note: we only land here on a real create; the idempotent fast-path above
  // returns without ever reaching this broadcast.
  try {
    realtimeHub.broadcast(user.id, input.projectId, {
      type: 'issue.created',
      payload: {
        projectId: input.projectId,
        project_id: input.projectId,
        issue: serialized,
      },
    });
  } catch (error) {
    // Broadcast must not fail the create.
    console.warn('[issues.create] broadcast failed:', error);
  }

  return NextResponse.json(serialized);
}
