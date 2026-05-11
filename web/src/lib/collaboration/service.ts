import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

export const MAX_COLLABORATION_MEMBERS = 5;

export const createCollaborationInviteToken = (): string =>
  randomBytes(32).toString('base64url');

const normalizeBaseUrl = (raw: string | undefined | null): string | null => {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }
  try {
    // Round-trip through URL so we reject garbage like "javascript:..." or
    // bare hostnames. We accept anything Url-parseable as a base.
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

// Build the canonical invite URL. The order of precedence is:
//   1. NEXT_PUBLIC_BASE_URL / NEXT_PUBLIC_URL — explicit production config
//   2. The Request's URL — only used when the env is unset, e.g. local dev
// Falling back to Request URL last avoids a `Host`-header phishing vector
// where a reverse proxy doesn't strip `X-Forwarded-Host` and an attacker can
// trick the server into embedding `https://attacker.example/app/invite/<real-token>`
// in the response.
export const buildInviteUrl = (request: { url: string }, inviteToken: string): string => {
  const configured =
    normalizeBaseUrl(process.env.NEXT_PUBLIC_BASE_URL) ??
    normalizeBaseUrl(process.env.NEXT_PUBLIC_URL);
  const base = configured ?? request.url;
  return new URL(`/app/invite/${encodeURIComponent(inviteToken)}`, base).toString();
};

type UserIdentity = {
  id: string;
  email?: string | null;
  phone?: string | null;
};

const formatUserLabel = (user: UserIdentity): string => {
  const email = user.email?.trim();
  if (email) {
    return email;
  }
  const phone = user.phone?.trim();
  if (phone) {
    return phone;
  }
  return `User ${user.id.slice(0, 8)}`;
};

export const collaborationMemberSelect = {
  id: true,
  userId: true,
  projectId: true,
  joinedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      phone: true,
    },
  },
  project: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.CollaborationMemberSelect;

export const collaborationSummarySelect = {
  id: true,
  inviteToken: true,
  createdAt: true,
  members: {
    orderBy: { joinedAt: 'asc' as const },
    select: collaborationMemberSelect,
  },
} satisfies Prisma.ProjectCollaborationSelect;

export type CollaborationSummaryRecord = Prisma.ProjectCollaborationGetPayload<{
  select: typeof collaborationSummarySelect;
}>;

export type CollaborationMemberSummaryRecord = CollaborationSummaryRecord['members'][number];

export const serializeCollaborationMember = (member: CollaborationMemberSummaryRecord) => {
  const joinedAt = member.joinedAt.toISOString();
  const label = formatUserLabel(member.user);
  // Do NOT expose raw email / phone over the wire. The collaboration MVP
  // intentionally surfaces only the display label so the invitation endpoint
  // (which any logged-in user can hit if they hold a token) cannot be used
  // to harvest member contact info. Frontend code paths only consume `label`
  // and `userId` — see ProjectItem, CreateIssueDialog, IssueCard, InvitePage.
  return {
    id: member.id,
    userId: member.userId,
    projectId: member.projectId,
    projectName: member.project.name,
    label,
    joinedAt,
    user: {
      id: member.user.id,
      label,
    },
    project: {
      id: member.project.id,
      name: member.project.name,
    },
    user_id: member.userId,
    project_id: member.projectId,
    project_name: member.project.name,
    joined_at: joinedAt,
  };
};

export const serializeCollaboration = (collaboration: CollaborationSummaryRecord) => {
  const createdAt = collaboration.createdAt.toISOString();
  const members = collaboration.members.map(serializeCollaborationMember);
  return {
    id: collaboration.id,
    inviteToken: collaboration.inviteToken,
    memberCount: collaboration.members.length,
    maxMembers: MAX_COLLABORATION_MEMBERS,
    members,
    createdAt,
    invite_token: collaboration.inviteToken,
    member_count: collaboration.members.length,
    max_members: MAX_COLLABORATION_MEMBERS,
    created_at: createdAt,
  };
};

export const issueUserSelect = {
  id: true,
  email: true,
  phone: true,
} satisfies Prisma.UserSelect;

export type IssueUserRecord = Prisma.UserGetPayload<{ select: typeof issueUserSelect }>;

export const serializeIssueUser = (user: IssueUserRecord | null | undefined) => {
  if (!user) {
    return null;
  }
  // See serializeCollaborationMember above — keep raw contact info off the
  // wire. Issue owner / creator displays only need `label`.
  const label = formatUserLabel(user);
  return {
    id: user.id,
    label,
  };
};

export const getAccessibleProjectIds = async (userId: string): Promise<string[]> => {
  const ownProjects = await db.project.findMany({
    where: { userId },
    select: {
      id: true,
      collaborationId: true,
    },
  });

  const projectIds = new Set(ownProjects.map((project) => project.id));
  const collaborationIds = [
    ...new Set(
      ownProjects
        .map((project) => project.collaborationId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];

  if (collaborationIds.length > 0) {
    const members = await db.collaborationMember.findMany({
      where: { collaborationId: { in: collaborationIds } },
      select: { projectId: true },
    });
    for (const member of members) {
      projectIds.add(member.projectId);
    }
  }

  return [...projectIds];
};

export const getProjectIssueScope = async (
  userId: string,
  projectId: string | null,
): Promise<string[] | null> => {
  if (!projectId) {
    return getAccessibleProjectIds(userId);
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      userId: true,
      collaborationId: true,
    },
  });
  if (!project) {
    return null;
  }

  if (project.userId !== userId) {
    if (!project.collaborationId) {
      return null;
    }
    const member = await db.collaborationMember.findUnique({
      where: {
        collaborationId_userId: {
          collaborationId: project.collaborationId,
          userId,
        },
      },
      select: { id: true },
    });
    if (!member) {
      return null;
    }
  }

  if (!project.collaborationId) {
    return [project.id];
  }

  const members = await db.collaborationMember.findMany({
    where: { collaborationId: project.collaborationId },
    select: { projectId: true },
  });
  return members.length > 0 ? members.map((member) => member.projectId) : [project.id];
};

export const getUserProjectForCollaboration = async (
  userId: string,
  collaborationId: string,
) => db.collaborationMember.findUnique({
  where: {
    collaborationId_userId: {
      collaborationId,
      userId,
    },
  },
  select: {
    project: {
      select: {
        id: true,
        userId: true,
        daemonHost: true,
        workspacePath: true,
        repoRoot: true,
        worktreeBranch: true,
        lastCommit: true,
      },
    },
  },
});

export const getAssignableIssueOwnerIds = async (project: {
  userId: string;
  collaborationId: string | null;
}): Promise<Set<string>> => {
  if (!project.collaborationId) {
    return new Set([project.userId]);
  }

  const members = await db.collaborationMember.findMany({
    where: { collaborationId: project.collaborationId },
    select: { userId: true },
  });
  return new Set(members.map((member) => member.userId));
};

export const isAssignableIssueOwner = async (
  project: {
    userId: string;
    collaborationId: string | null;
  },
  ownerUserId: string,
): Promise<boolean> => {
  const ownerIds = await getAssignableIssueOwnerIds(project);
  return ownerIds.has(ownerUserId);
};
