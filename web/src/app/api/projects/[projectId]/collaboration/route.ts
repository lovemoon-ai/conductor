import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import {
  buildInviteUrl,
  collaborationSummarySelect,
  createCollaborationInviteToken,
  serializeCollaboration,
} from '@/lib/collaboration/service';

const serializeCollaborationResponse = (request: NextRequest, collaboration: Parameters<typeof serializeCollaboration>[0]) => {
  const serialized = serializeCollaboration(collaboration);
  const inviteUrl = buildInviteUrl(request, collaboration.inviteToken);
  return {
    collaboration: {
      ...serialized,
      inviteUrl,
      invite_url: inviteUrl,
    },
    inviteToken: collaboration.inviteToken,
    inviteUrl,
    invite_token: collaboration.inviteToken,
    invite_url: inviteUrl,
  };
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const { projectId } = await params;

  try {
    const result = await db.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: {
          id: projectId,
          userId: user.id,
        },
        select: {
          id: true,
          collaborationId: true,
          collaboration: {
            select: collaborationSummarySelect,
          },
          // Default project is the user's personal scratch — it cannot be
          // turned into a shared collaboration via any client surface.
          defaultProject: {
            select: { id: true },
          },
        },
      });

      if (!project) {
        return { kind: 'not-found' as const };
      }

      if (project.defaultProject) {
        return { kind: 'default-blocked' as const };
      }

      if (project.collaboration) {
        return { kind: 'ok' as const, collaboration: project.collaboration };
      }

      const created = await tx.projectCollaboration.create({
        data: {
          inviteToken: createCollaborationInviteToken(),
          members: {
            create: {
              userId: user.id,
              projectId: project.id,
            },
          },
        },
        select: collaborationSummarySelect,
      });

      await tx.project.update({
        where: { id: project.id },
        data: { collaborationId: created.id },
      });

      return { kind: 'ok' as const, collaboration: created };
    });

    if (result.kind === 'not-found') {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (result.kind === 'default-blocked') {
      return NextResponse.json(
        { error: 'The default project cannot be shared. Create a new project to start a collaboration.' },
        { status: 400 },
      );
    }

    return NextResponse.json(serializeCollaborationResponse(request, result.collaboration));
  } catch (error) {
    // A concurrent owner-side create can lose the race on either the
    // CollaborationMember.projectId @unique constraint or the implicit
    // Project.collaborationId update. In both cases the project IS already
    // attached to a collaboration that we own — re-fetch and return it so the
    // caller gets the same idempotent shape as the winner.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await db.project.findFirst({
        where: { id: projectId, userId: user.id },
        select: {
          collaboration: { select: collaborationSummarySelect },
        },
      });
      if (existing?.collaboration) {
        return NextResponse.json(serializeCollaborationResponse(request, existing.collaboration));
      }
      return NextResponse.json({ error: 'Project is already in a collaboration' }, { status: 409 });
    }
    throw error;
  }
}
