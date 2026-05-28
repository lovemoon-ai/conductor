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
import { isMissingProjectSortOrderColumnError } from '@/app/api/projects/shared';

const joinCollaborationSchema = z.object({
  inviteToken: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
  createProjectName: z.string().trim().min(1).optional(),
}).refine(
  (input) => Boolean(input.projectId) !== Boolean(input.createProjectName),
  {
    message: 'Provide either projectId or createProjectName',
    path: ['projectId'],
  },
);

const readStringField = (
  record: Record<string, unknown>,
  camelCaseKey: string,
  snakeCaseKey: string,
): string | undefined => {
  const value =
    typeof record[camelCaseKey] === 'string'
      ? record[camelCaseKey]
      : typeof record[snakeCaseKey] === 'string'
        ? record[snakeCaseKey]
        : undefined;
  return value;
};

const getNextProjectSortOrder = async (
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<number | null> => {
  try {
    const result = await tx.project.aggregate({
      where: { userId },
      _max: { sortOrder: true },
    });
    const maxSortOrder = result._max.sortOrder;
    return typeof maxSortOrder === 'number' && Number.isInteger(maxSortOrder)
      ? maxSortOrder + 1
      : 0;
  } catch (error) {
    if (isMissingProjectSortOrderColumnError(error)) {
      return null;
    }
    throw error;
  }
};

const normalizeJoinBody = (body: unknown) => {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  return {
    inviteToken: readStringField(record, 'inviteToken', 'invite_token') ?? '',
    projectId: readStringField(record, 'projectId', 'project_id'),
    createProjectName: readStringField(record, 'createProjectName', 'create_project_name'),
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

  const { inviteToken, projectId, createProjectName } = parsed.data;

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

        const memberByUserId = new Map<string, { userId: string; projectId: string }>(
          collaboration.members.map((member: { userId: string; projectId: string }) => [member.userId, member]),
        );
        const existingMember = memberByUserId.get(user.id) ?? null;
        let targetProjectId: string;
        let targetProjectCollaborationId: string | null;

        if (createProjectName) {
          if (existingMember) {
            return {
              status: 409 as const,
              body: {
                error: 'You already joined this collaboration with a different project. Leave it first to switch.',
              },
            };
          }
          if (collaboration.members.length >= MAX_COLLABORATION_MEMBERS) {
            return { status: 409 as const, body: { error: 'Collaboration is full' } };
          }

          const nameConflict = await tx.project.findFirst({
            where: {
              userId: user.id,
              name: createProjectName,
            },
            select: { id: true },
          });
          if (nameConflict) {
            return { status: 409 as const, body: { error: 'Project name already exists' } };
          }

          const nextSortOrder = await getNextProjectSortOrder(tx, user.id);
          const createdProject = await tx.project.create({
            data: {
              userId: user.id,
              name: createProjectName,
              daemonHost: null,
              workspacePath: null,
              repoRoot: null,
              worktreeBranch: null,
              lastCommit: null,
              fileCount: null,
              metadata: null,
              collaborationId: collaboration.id,
              ...(nextSortOrder === null ? {} : { sortOrder: nextSortOrder }),
            },
            select: { id: true },
          });
          targetProjectId = createdProject.id;
          targetProjectCollaborationId = collaboration.id;
        } else {
          if (!projectId) {
            return { status: 400 as const, body: { error: 'Project is required' } };
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
          targetProjectId = targetProject.id;
          targetProjectCollaborationId = targetProject.collaborationId;
        }

        if (!existingMember) {
          if (!createProjectName && collaboration.members.length >= MAX_COLLABORATION_MEMBERS) {
            return { status: 409 as const, body: { error: 'Collaboration is full' } };
          }

          await tx.collaborationMember.create({
            data: {
              collaborationId: collaboration.id,
              userId: user.id,
              projectId: targetProjectId,
            },
          });
          const memberCount = await tx.collaborationMember.count({
            where: { collaborationId: collaboration.id },
          });
          if (memberCount > MAX_COLLABORATION_MEMBERS) {
            throw new CollaborationFullError();
          }
          if (targetProjectCollaborationId !== collaboration.id) {
            await tx.project.update({
              where: { id: targetProjectId },
              data: { collaborationId: collaboration.id },
            });
          }
        } else if (existingMember.projectId !== targetProjectId) {
          return {
            status: 409 as const,
            body: {
              error: 'You already joined this collaboration with a different project. Leave it first to switch.',
            },
          };
        } else if (targetProjectCollaborationId !== collaboration.id) {
          await tx.project.update({
            where: { id: targetProjectId },
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
            projectId: targetProjectId,
            project_id: targetProjectId,
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
