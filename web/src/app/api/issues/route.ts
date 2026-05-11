import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { getProjectIssueScope, isAssignableIssueOwner } from '@/lib/collaboration/service';
import { db } from '@/lib/db';
import {
  getNextIssuePosition,
  ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE,
  isDefaultIssuePriority,
  issueCreateSchema,
  issueSerializationSelect,
  issueSerializationWithPrioritySelect,
  isMissingIssuePriorityColumnError,
  loadIssueTaskMaps,
  normalizeIssueCreateBody,
  serializeIssueWithTasks,
  warnMissingIssuePrioritySchema,
  withIssuePrioritySchemaFallback,
} from './shared';

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('project_id')?.trim() || null;
  const projectIds = await getProjectIssueScope(user.id, projectId);
  if (!projectIds) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const listQuery = {
    where: {
      projectId: { in: projectIds },
    },
    orderBy: [
      { status: 'asc' as const },
      { position: 'asc' as const },
      { updatedAt: 'desc' as const },
    ],
  };

  const { result: issues } = await withIssuePrioritySchemaFallback(
    'issues.list',
    () => db.issue.findMany({
      ...listQuery,
      select: issueSerializationWithPrioritySelect,
    }),
    () => db.issue.findMany({
      ...listQuery,
      select: issueSerializationSelect,
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
    ownerUserId?: string | null;
    creatorUserId?: string | null;
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
    select: { id: true, userId: true, collaborationId: true },
  });

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  const ownerUserId = input.ownerUserId ?? user.id;
  if (!(await isAssignableIssueOwner(project, ownerUserId))) {
    return NextResponse.json({ error: 'Issue owner is not a collaboration member' }, { status: 400 });
  }

  const position = typeof input.position === 'number'
    ? input.position
    : await getNextIssuePosition(input.projectId, input.status);

  const issueData = {
    projectId: input.projectId,
    ownerUserId,
    creatorUserId: user.id,
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    priority: input.priority,
    position,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };

  let issue;
  try {
    issue = await db.issue.create({
      data: issueData,
      select: issueSerializationWithPrioritySelect,
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
        ownerUserId: issueData.ownerUserId,
        creatorUserId: issueData.creatorUserId,
        title: issueData.title,
        description: issueData.description,
        status: issueData.status,
        position: issueData.position,
        metadata: issueData.metadata,
      },
      select: issueSerializationSelect,
    });
  }

  return NextResponse.json(serializeIssueWithTasks(issue));
}
