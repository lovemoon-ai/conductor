import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import {
  getNextIssuePosition,
  issueCreateSchema,
  loadIssueTaskMaps,
  normalizeIssueCreateBody,
  serializeIssueWithTasks,
} from './shared';

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('project_id')?.trim() || null;

  const issues = await db.issue.findMany({
    where: {
      project: { userId: user.id },
      ...(projectId ? { projectId } : {}),
    },
    orderBy: [
      { status: 'asc' },
      { position: 'asc' },
      { updatedAt: 'desc' },
    ],
  });

  const { activeTaskByIssueId, linkedTaskByIssueId } = await loadIssueTaskMaps(
    user.id,
    issues.map((issue: { id: string }) => issue.id),
  );

  return NextResponse.json(issues.map((issue: {
    id: string;
    projectId: string;
    title: string;
    description: string | null;
    status: string;
    position: number;
    metadata: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) => serializeIssueWithTasks(issue, {
    activeTask: activeTaskByIssueId.get(issue.id) ?? null,
    linkedTask: linkedTaskByIssueId.get(issue.id) ?? null,
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

  const position = typeof input.position === 'number'
    ? input.position
    : await getNextIssuePosition(input.projectId, input.status);

  const issue = await db.issue.create({
    data: {
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? null,
      status: input.status,
      position,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    },
  });

  return NextResponse.json(serializeIssueWithTasks(issue));
}
