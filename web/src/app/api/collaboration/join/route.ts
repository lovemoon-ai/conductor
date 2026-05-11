import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import {
  collaborationSummarySelect,
  MAX_COLLABORATION_MEMBERS,
  serializeCollaboration,
} from '@/lib/collaboration/service';

const joinCollaborationSchema = z.object({
  inviteToken: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});

const normalizeJoinBody = (body: unknown) => {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  return {
    inviteToken:
      typeof record.inviteToken === 'string'
        ? record.inviteToken
        : typeof record.invite_token === 'string'
          ? record.invite_token
          : '',
    projectId:
      typeof record.projectId === 'string'
        ? record.projectId
        : typeof record.project_id === 'string'
          ? record.project_id
          : '',
  };
};

class CollaborationFullError extends Error {
  constructor() {
    super('Collaboration is full');
    this.name = 'CollaborationFullError';
  }
}

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const body = await request.json().catch(() => null);
  const parsed = joinCollaborationSchema.safeParse(normalizeJoinBody(body));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { inviteToken, projectId } = parsed.data;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await db.$transaction(async (tx) => {
        const collaboration = await tx.projectCollaboration.findUnique({
          where: { inviteToken },
          select: {
            id: true,
            members: {
              select: {
                userId: true,
                projectId: true,
              },
            },
          },
        });
        if (!collaboration) {
          return { status: 404 as const, body: { error: 'Collaboration invite not found' } };
        }

        const targetProject = await tx.project.findFirst({
          where: {
            id: projectId,
            userId: user.id,
          },
          select: {
            id: true,
            collaborationId: true,
            // Symmetric guard with POST /projects/[id]/collaboration: the
            // default project is personal scratch and cannot be paired into a
            // shared collaboration even from the invite-acceptance side.
            defaultProject: { select: { id: true } },
          },
        });
        if (!targetProject) {
          return { status: 403 as const, body: { error: 'Project not found' } };
        }
        if (targetProject.defaultProject) {
          return {
            status: 400 as const,
            body: {
              error: 'The default project cannot be shared. Pick a non-default project to join with.',
            },
          };
        }
        if (targetProject.collaborationId && targetProject.collaborationId !== collaboration.id) {
          return { status: 409 as const, body: { error: 'Project is already in a collaboration' } };
        }

        const existingMember = collaboration.members.find((member) => member.userId === user.id) ?? null;
        if (!existingMember) {
          if (collaboration.members.length >= MAX_COLLABORATION_MEMBERS) {
            return { status: 409 as const, body: { error: 'Collaboration is full' } };
          }

          await tx.collaborationMember.create({
            data: {
              collaborationId: collaboration.id,
              userId: user.id,
              projectId: targetProject.id,
            },
          });
          const memberCount = await tx.collaborationMember.count({
            where: { collaborationId: collaboration.id },
          });
          if (memberCount > MAX_COLLABORATION_MEMBERS) {
            throw new CollaborationFullError();
          }
          await tx.project.update({
            where: { id: targetProject.id },
            data: { collaborationId: collaboration.id },
          });
        } else if (existingMember.projectId !== targetProject.id) {
          return {
            status: 409 as const,
            body: {
              error: 'You already joined this collaboration with a different project. Leave it first to switch.',
            },
          };
        } else if (targetProject.collaborationId !== collaboration.id) {
          await tx.project.update({
            where: { id: targetProject.id },
            data: { collaborationId: collaboration.id },
          });
        }

        const updated = await tx.projectCollaboration.findUnique({
          where: { id: collaboration.id },
          select: collaborationSummarySelect,
        });
        if (!updated) {
          return { status: 404 as const, body: { error: 'Collaboration invite not found' } };
        }

        return {
          status: 200 as const,
          body: {
            collaboration: serializeCollaboration(updated),
            collaborationId: updated.id,
            collaboration_id: updated.id,
          },
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

      return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
      if (error instanceof CollaborationFullError) {
        return NextResponse.json({ error: 'Collaboration is full' }, { status: 409 });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt === 0) {
        continue;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        return NextResponse.json({ error: 'Collaboration join conflicted, please retry' }, { status: 409 });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NextResponse.json({ error: 'Project or user is already in a collaboration' }, { status: 409 });
      }
      // Concurrent leave-of-last-member can drop the ProjectCollaboration row
      // between findUnique and the nested CollaborationMember create, so the
      // FK insert lands with no parent. Surface a 410 GONE so the invite page
      // can show "this invite link is no longer valid" instead of a 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        return NextResponse.json({ error: 'Collaboration invite is no longer valid' }, { status: 410 });
      }
      throw error;
    }
  }

  return NextResponse.json({ error: 'Collaboration join conflicted, please retry' }, { status: 409 });
}
