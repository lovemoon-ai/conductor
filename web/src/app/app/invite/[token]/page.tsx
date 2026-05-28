'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { InlineNotice } from '@/components/common/InlineNotice';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useToast } from '@/components/common/FeedbackProvider';
import { useProjectsStore } from '@/features/projects';
import { getApiClient } from '@/shared/api/client';

type InviteProject = {
  id: string;
  name: string;
  daemonHost?: string | null;
  workspacePath?: string | null;
  alreadyInCollaboration: boolean;
  canJoin: boolean;
};

type InviteMember = {
  userId: string;
  projectName?: string;
  label: string;
};

type InviteData = {
  collaboration: {
    id: string;
    memberCount: number;
    maxMembers: number;
    members: InviteMember[];
  };
  candidateProjects: InviteProject[];
  alreadyJoined: boolean;
  isFull: boolean;
  suggestedProjectName?: string;
  suggestedProjectNameExists: boolean;
  suggestedProjectNameAvailable: boolean;
};

const normalizeInviteProject = (raw: unknown): InviteProject | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const name = typeof record.name === 'string' ? record.name : '';
  if (!id || !name) return null;
  return {
    id,
    name,
    daemonHost: typeof record.daemonHost === 'string' ? record.daemonHost : typeof record.daemon_host === 'string' ? record.daemon_host : null,
    workspacePath: typeof record.workspacePath === 'string' ? record.workspacePath : typeof record.workspace_path === 'string' ? record.workspace_path : null,
    alreadyInCollaboration: Boolean(record.alreadyInCollaboration ?? record.already_in_collaboration),
    canJoin: Boolean(record.canJoin ?? record.can_join),
  };
};

const normalizeInviteData = (raw: unknown): InviteData | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const collaboration = record.collaboration && typeof record.collaboration === 'object' && !Array.isArray(record.collaboration)
    ? record.collaboration as Record<string, unknown>
    : null;
  if (!collaboration || typeof collaboration.id !== 'string') return null;
  const rawMembers = Array.isArray(collaboration.members) ? collaboration.members : [];
  const members = rawMembers.reduce<InviteMember[]>((acc, member) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return acc;
    const memberRecord = member as Record<string, unknown>;
    const userId = typeof memberRecord.userId === 'string' ? memberRecord.userId : typeof memberRecord.user_id === 'string' ? memberRecord.user_id : '';
    const label = typeof memberRecord.label === 'string' ? memberRecord.label : userId;
    if (!userId || !label) return acc;
    const projectName = typeof memberRecord.projectName === 'string'
      ? memberRecord.projectName
      : typeof memberRecord.project_name === 'string'
        ? memberRecord.project_name
        : undefined;
    acc.push({
      userId,
      label,
      ...(projectName ? { projectName } : {}),
    });
    return acc;
  }, []);
  const rawCandidateProjects = record.candidateProjects ?? record.candidate_projects;
  const candidateProjects = Array.isArray(rawCandidateProjects)
    ? rawCandidateProjects
        .map(normalizeInviteProject)
        .filter((project): project is InviteProject => project !== null)
    : [];
  return {
    collaboration: {
      id: collaboration.id,
      memberCount: typeof collaboration.memberCount === 'number'
        ? collaboration.memberCount
        : typeof collaboration.member_count === 'number'
          ? collaboration.member_count
          : members.length,
      maxMembers: typeof collaboration.maxMembers === 'number'
        ? collaboration.maxMembers
        : typeof collaboration.max_members === 'number'
          ? collaboration.max_members
          : 5,
      members,
    },
    candidateProjects,
    alreadyJoined: Boolean(record.alreadyJoined ?? record.already_joined),
    isFull: Boolean(record.isFull ?? record.is_full),
    suggestedProjectName: typeof record.suggestedProjectName === 'string'
      ? record.suggestedProjectName
      : typeof record.suggested_project_name === 'string'
        ? record.suggested_project_name
        : undefined,
    suggestedProjectNameExists: Boolean(record.suggestedProjectNameExists ?? record.suggested_project_name_exists),
    suggestedProjectNameAvailable: typeof record.suggestedProjectNameAvailable === 'boolean'
      ? record.suggestedProjectNameAvailable
      : typeof record.suggested_project_name_available === 'boolean'
        ? record.suggested_project_name_available
        : !Boolean(record.suggestedProjectNameExists ?? record.suggested_project_name_exists),
  };
};

const normalizeJoinedProjectId = (raw: unknown): string | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return typeof record.projectId === 'string'
    ? record.projectId
    : typeof record.project_id === 'string'
      ? record.project_id
      : null;
};

const suggestSharedProjectName = (members: InviteMember[]): string => {
  const inviterProjectName = members.find((member) => member.projectName)?.projectName?.trim();
  return inviterProjectName || 'Shared workspace';
};

const getSuggestedProjectName = (invite: InviteData): string => {
  const apiSuggestion = invite.suggestedProjectName?.trim();
  return apiSuggestion || suggestSharedProjectName(invite.collaboration.members);
};

const pickDefaultJoinProjectId = (invite: InviteData): string => {
  const suggestedName = getSuggestedProjectName(invite);
  const joinableProjects = invite.candidateProjects.filter((project) => project.canJoin && !project.alreadyInCollaboration);
  return joinableProjects.find((project) => project.name.trim() === suggestedName)?.id
    ?? joinableProjects[0]?.id
    ?? '';
};

export default function CollaborationInvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const { push } = useRouter();
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);
  const { pushToast } = useToast();
  const [data, setData] = useState<InviteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isJoining, setIsJoining] = useState(false);
  const [isCreatingAndJoining, setIsCreatingAndJoining] = useState(false);

  const joinableProjects = useMemo(
    () => data?.candidateProjects.filter((project) => project.canJoin && !project.alreadyInCollaboration) ?? [],
    [data],
  );
  const suggestedProjectName = data ? getSuggestedProjectName(data) : 'Shared workspace';
  const canCreateSuggestedProject = Boolean(data && data.suggestedProjectNameAvailable && !data.suggestedProjectNameExists);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const api = getApiClient();
        const invite = normalizeInviteData(await api.get(`/invitations/${encodeURIComponent(token)}`));
        if (!invite) {
          throw new Error('Invalid invitation response');
        }
        if (cancelled) return;
        setData(invite);
        setSelectedProjectId(pickDefaultJoinProjectId(invite));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load invitation');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleJoin = async () => {
    if (!selectedProjectId || isJoining) {
      return;
    }
    setIsJoining(true);
    setError(null);
    try {
      const api = getApiClient();
      await api.post('/collaboration/join', {
        inviteToken: token,
        projectId: selectedProjectId,
      });
      await fetchProjects();
      pushToast({
        title: 'Joined collaboration',
        variant: 'success',
      });
      push(`/app/issues?projectId=${encodeURIComponent(selectedProjectId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join collaboration');
    } finally {
      setIsJoining(false);
    }
  };

  const completeJoin = async (projectId: string) => {
    await fetchProjects();
    pushToast({
      title: 'Joined collaboration',
      variant: 'success',
    });
    push(`/app/issues?projectId=${encodeURIComponent(projectId)}`);
  };

  const markSuggestedProjectNameUnavailable = () => {
    setData((current) => current
      ? {
          ...current,
          suggestedProjectNameExists: true,
          suggestedProjectNameAvailable: false,
        }
      : current);
  };

  const handleCreateAndJoin = async () => {
    if (!data || isCreatingAndJoining || !canCreateSuggestedProject) {
      return;
    }
    setIsCreatingAndJoining(true);
    setError(null);
    try {
      const api = getApiClient();
      const joinResponse = await api.post<unknown>('/collaboration/join', {
        inviteToken: token,
        createProjectName: suggestedProjectName,
      });
      const projectId = normalizeJoinedProjectId(joinResponse);
      if (!projectId) {
        throw new Error('Invalid join response');
      }
      await completeJoin(projectId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create and join';
      if (message === 'Project name already exists') {
        markSuggestedProjectNameUnavailable();
      }
      setError(message);
    } finally {
      setIsCreatingAndJoining(false);
    }
  };

  return (
    <>
      <Header title="Join Collaboration" compact />

      <div className="flex-1 overflow-y-auto p-4 webapp-scrollbar">
        <div className="mx-auto max-w-xl space-y-4">
          {isLoading ? (
            <div className="flex min-h-64 items-center justify-center rounded-2xl border border-border bg-panel/60">
              <LoadingSpinner size="lg" />
            </div>
          ) : error && !data ? (
            <InlineNotice variant="error" title="Invitation unavailable">
              {error}
            </InlineNotice>
          ) : data ? (
            <div className="rounded-2xl border border-border bg-panel/80 p-5 shadow-sm">
              <div className="mb-5">
                <h2 className="text-lg font-semibold text-ink">Shared issue board</h2>
                <p className="mt-1 text-sm text-muted">
                  {data.collaboration.memberCount}/{data.collaboration.maxMembers} members joined
                </p>
              </div>

              <div className="mb-5 flex flex-wrap gap-2">
                {data.collaboration.members.map((member) => (
                  <span key={member.userId} className="rounded-full border border-border bg-paper/60 px-3 py-1 text-xs text-ink">
                    {member.projectName ? `${member.label} · ${member.projectName}` : member.label}
                  </span>
                ))}
              </div>

              {error ? (
                <div className="mb-5">
                  <InlineNotice variant="error" title="Could not complete">
                    {error}
                  </InlineNotice>
                </div>
              ) : null}

              {data.alreadyJoined ? (
                <InlineNotice variant="info" title="Already joined">
                  This account is already a member of the collaboration.
                </InlineNotice>
              ) : data.isFull ? (
                <InlineNotice variant="warning" title="Collaboration is full">
                  Ask a member to create a new collaboration link.
                </InlineNotice>
              ) : joinableProjects.length === 0 ? (
                <div className="space-y-4">
                  <InlineNotice
                    variant={canCreateSuggestedProject ? 'info' : 'warning'}
                    title={canCreateSuggestedProject ? 'No project available to pair' : 'Project already exists'}
                  >
                    {canCreateSuggestedProject ? (
                      <>
                        Every project you own is already in another collaboration (or is the
                        default scratch project, which can't be shared). Create a new local project
                        and we'll pair it with this collaboration immediately.
                      </>
                    ) : (
                      <>
                        A project named "{suggestedProjectName}" already exists, so we won't create
                        another one automatically. Leave it from its current collaboration or create
                        a differently named local project from Projects, then reopen this invite.
                      </>
                    )}
                  </InlineNotice>
                  {canCreateSuggestedProject ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleCreateAndJoin()}
                        disabled={isCreatingAndJoining}
                        className="webapp-btn-primary w-full px-5 py-2.5 text-sm disabled:opacity-60"
                      >
                        {isCreatingAndJoining
                          ? 'Creating project & joining...'
                          : `Create "${suggestedProjectName}" & join`}
                      </button>
                      <p className="text-xs text-muted">
                        The new project is unbound. Attach a daemon later from the project list when
                        you want to run tasks on your own machine.
                      </p>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="join-collaboration-project" className="mb-2 block text-sm font-medium text-ink">
                      Pair with project
                    </label>
                    <select
                      id="join-collaboration-project"
                      value={selectedProjectId}
                      onChange={(event) => setSelectedProjectId(event.target.value)}
                      className="w-full webapp-input"
                    >
                      {joinableProjects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleJoin()}
                    disabled={!selectedProjectId || isJoining}
                    className="webapp-btn-primary w-full px-5 py-2.5 text-sm disabled:opacity-60"
                  >
                    {isJoining ? 'Joining...' : 'Join'}
                  </button>

                  {canCreateSuggestedProject ? (
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer hover:text-ink">
                        Or create a brand new project for this collaboration
                      </summary>
                      <div className="mt-2 space-y-2">
                        <button
                          type="button"
                          onClick={() => void handleCreateAndJoin()}
                          disabled={isCreatingAndJoining}
                          className="inline-flex w-full items-center justify-center rounded-lg border border-border px-4 py-2 text-xs font-medium text-ink transition-colors hover:bg-border/40 disabled:opacity-60"
                        >
                          {isCreatingAndJoining
                            ? 'Creating project & joining...'
                            : `Create "${suggestedProjectName}" & join`}
                        </button>
                      </div>
                    </details>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
