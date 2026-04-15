import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import {
  getNextIssuePosition,
  issueCreateSchema,
  issueWithActiveTaskInclude,
  normalizeIssueCreateBody,
  serializeIssueWithActiveTask,
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
    include: issueWithActiveTaskInclude,
    orderBy: [
      { status: 'asc' },
      { position: 'asc' },
      { updatedAt: 'desc' },
    ],
  });

  return NextResponse.json(issues.map((issue) => serializeIssueWithActiveTask(issue)));
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
    include: issueWithActiveTaskInclude,
  });

  return NextResponse.json(serializeIssueWithActiveTask(issue));
}
