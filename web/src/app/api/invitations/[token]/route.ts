import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import {
  collaborationSummarySelect,
  MAX_COLLABORATION_MEMBERS,
  serializeCollaboration,
  type CollaborationSummaryRecord,
} from '@/lib/collaboration/service';

const suggestSharedProjectName = (collaboration: CollaborationSummaryRecord): string => {
  const inviterProjectName = collaboration.members
    .find((member) => member.project.name.trim().length > 0)
    ?.project.name.trim();
  return inviterProjectName || 'Shared workspace';
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const { token } = await params;

  const collaboration = await db.projectCollaboration.findUnique({
    where: { inviteToken: token },
    select: collaborationSummarySelect,
  });
  if (!collaboration) {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }

  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      daemonHost: true,
      workspacePath: true,
      collaborationId: true,
      // Default project is the user's personal scratch and cannot be paired
      // into a collaboration — exclude it from the candidate list so the
      // invite page never offers it as a pickable option.
      defaultProject: { select: { id: true } },
    },
  });

  const alreadyJoined = collaboration.members.some((member) => member.userId === user.id);
  const isFull = collaboration.members.length >= MAX_COLLABORATION_MEMBERS;
  const suggestedProjectName = suggestSharedProjectName(collaboration);
  const suggestedProjectNameExists = projects.some(
    (project) => project.name.trim() === suggestedProjectName,
  );
  const candidateProjects = projects
    .filter((project) => !project.defaultProject)
    .map((project) => ({
    id: project.id,
    name: project.name,
    daemonHost: project.daemonHost,
    workspacePath: project.workspacePath,
    alreadyInCollaboration: Boolean(project.collaborationId),
    canJoin: !isFull && (!project.collaborationId || project.collaborationId === collaboration.id),
    daemon_host: project.daemonHost,
    workspace_path: project.workspacePath,
    already_in_collaboration: Boolean(project.collaborationId),
    can_join: !isFull && (!project.collaborationId || project.collaborationId === collaboration.id),
  }));

  return NextResponse.json({
    collaboration: serializeCollaboration(collaboration),
    candidateProjects,
    alreadyJoined,
    isFull,
    suggestedProjectName,
    suggestedProjectNameExists,
    suggestedProjectNameAvailable: !suggestedProjectNameExists,
    candidate_projects: candidateProjects,
    already_joined: alreadyJoined,
    is_full: isFull,
    suggested_project_name: suggestedProjectName,
    suggested_project_name_exists: suggestedProjectNameExists,
    suggested_project_name_available: !suggestedProjectNameExists,
  });
}
