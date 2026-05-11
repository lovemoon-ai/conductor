import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';

const RUNNING_ISSUE_STATUSES = ['doing', 'review'];

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ collaborationId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const { collaborationId } = await params;

  const result = await db.$transaction(async (tx) => {
    const member = await tx.collaborationMember.findUnique({
      where: {
        collaborationId_userId: {
          collaborationId,
          userId: user.id,
        },
      },
      select: {
        id: true,
        projectId: true,
      },
    });
    if (!member) {
      return { status: 404 as const, body: { error: 'Collaboration membership not found' } };
    }

    const remainingMembers = await tx.collaborationMember.findMany({
      where: {
        collaborationId,
        id: { not: member.id },
      },
      orderBy: { joinedAt: 'asc' },
      select: {
        userId: true,
        projectId: true,
      },
    });

    const remainingProjectIds = remainingMembers.map((remainingMember) => remainingMember.projectId);
    const ownedRunningIssueInRemainingProjects = remainingProjectIds.length > 0
      ? await tx.issue.findFirst({
          where: {
            ownerUserId: user.id,
            projectId: { in: remainingProjectIds },
            status: { in: RUNNING_ISSUE_STATUSES },
          },
          select: { id: true },
        })
      : null;
    if (ownedRunningIssueInRemainingProjects) {
      return {
        status: 409 as const,
        body: { error: 'Move owned running issues out of doing before leaving collaboration' },
      };
    }

    const externalRunningIssueInLeavingProject = await tx.issue.findFirst({
      where: {
        projectId: member.projectId,
        ownerUserId: { not: user.id },
        status: { in: RUNNING_ISSUE_STATUSES },
      },
      select: { id: true },
    });
    if (externalRunningIssueInLeavingProject) {
      return {
        status: 409 as const,
        body: { error: 'Ask collaborators to move running issues out of doing before leaving collaboration' },
      };
    }

    await tx.collaborationMember.delete({
      where: { id: member.id },
    });
    await tx.project.update({
      where: { id: member.projectId },
      data: { collaborationId: null },
    });

    if (remainingMembers.length === 0) {
      await tx.projectCollaboration.delete({
        where: { id: collaborationId },
      });
    } else {
      await tx.issue.updateMany({
        where: {
          ownerUserId: user.id,
          projectId: { in: remainingProjectIds },
        },
        data: {
          ownerUserId: remainingMembers[0].userId,
        },
      });
    }

    await tx.issue.updateMany({
      where: {
        projectId: member.projectId,
        ownerUserId: { not: user.id },
      },
      data: {
        ownerUserId: user.id,
      },
    });

    return { status: 204 as const, body: null };
  });

  if (result.status === 204) {
    return new NextResponse(null, { status: 204 });
  }
  return NextResponse.json(result.body, { status: result.status });
}
