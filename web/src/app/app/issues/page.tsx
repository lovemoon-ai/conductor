'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@/components/common/FeedbackProvider';
import { Header } from '@/components/layout/Header';
import { useAgentsStore } from '@/features/agents';
import {
  CreateIssueDialog,
  IssueBoard,
  IssueList,
  MoveIssueToDoingDialog,
  useIssuesStore,
} from '@/features/issues';
import { useProjectsStore } from '@/features/projects';
import { RefreshIcon } from '@/features/tasks';
import {
  calculateIssueAppendPosition,
  calculateIssuePositionFromPlacement,
  getIssueAppendPlacement,
  type IssueMovePlacement,
} from '@/features/issues/components/board-utils';
import type { IssueOwnerOption } from '@/features/issues/components/IssueCard';
import type { Agent, Issue, IssueStatus, Project } from '@/shared/types';

const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

const isConductorFireHost = (host: string | null | undefined): boolean =>
  typeof host === 'string' && host.startsWith('conductor-fire-');

const pickIssueBackend = (issue: Issue | null): string | null => {
  if (!issue?.metadata || typeof issue.metadata.backendType !== 'string') {
    return null;
  }
  const backendType = issue.metadata.backendType.trim();
  return backendType || null;
};

const getIssueBackendOptions = (project: Project | null, agents: Agent[]): string[] => {
  if (!project) {
    return [];
  }

  const defaultProject = Boolean(project.isDefault);
  const projectDaemonHost = typeof project.daemonHost === 'string' ? project.daemonHost.trim() : '';
  if (!defaultProject && !projectDaemonHost) {
    return [];
  }
  const scopedAgents = !defaultProject && projectDaemonHost
    ? agents.filter((agent) => agent.host === projectDaemonHost)
    : agents.filter((agent) => !isConductorFireHost(agent.host));

  const seen = new Set<string>();
  const availableBackends: string[] = [];
  for (const agent of scopedAgents) {
    for (const backend of agent.supportedBackends ?? []) {
      const normalizedBackend = backend.trim();
      if (!normalizedBackend || seen.has(normalizedBackend)) {
        continue;
      }
      seen.add(normalizedBackend);
      availableBackends.push(normalizedBackend);
    }
  }

  return availableBackends;
};

type PendingIssueStart = {
  issueId: string;
  status: IssueStatus;
  placement: IssueMovePlacement;
  availableBackends: string[];
};

function IssuesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [pendingIssueStart, setPendingIssueStart] = useState<PendingIssueStart | null>(null);
  const [hasRequestedProjects, setHasRequestedProjects] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    typeof window !== 'undefined' ? window.matchMedia(DESKTOP_MEDIA_QUERY).matches : false,
  );
  const { pushToast } = useToast();

  const agents = useAgentsStore((state) => state.agents);
  const projects = useProjectsStore((state) => state.projects);
  const hiddenProjectIds = useProjectsStore((state) => state.hiddenProjectIds);
  const isProjectsLoading = useProjectsStore((state) => state.isLoading);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);
  const setSelectedProjectId = useProjectsStore((state) => state.setSelectedProjectId);

  const issues = useIssuesStore((state) => state.issues);
  const isIssuesLoading = useIssuesStore((state) => state.isLoading);
  const fetchIssues = useIssuesStore((state) => state.fetchIssues);
  const moveIssue = useIssuesStore((state) => state.moveIssue);
  const updateIssue = useIssuesStore((state) => state.updateIssue);
  const deleteIssue = useIssuesStore((state) => state.deleteIssue);

  const projectIdFromUrl = searchParams.get('projectId');
  const hiddenProjectIdSet = useMemo(() => new Set(hiddenProjectIds), [hiddenProjectIds]);

  useEffect(() => {
    setHasRequestedProjects(true);
    void fetchProjects();
  }, [fetchProjects]);

  const resolvedProjectId = useMemo(() => {
    if (
      projectIdFromUrl
      && !hiddenProjectIdSet.has(projectIdFromUrl)
      && projects.some((project) => project.id === projectIdFromUrl)
    ) {
      return projectIdFromUrl;
    }
    return null;
  }, [hiddenProjectIdSet, projectIdFromUrl, projects]);
  const currentProject = useMemo(
    () => projects.find((project) => project.id === resolvedProjectId) ?? null,
    [projects, resolvedProjectId],
  );
  const visibleIssues = useMemo(() => (
    resolvedProjectId
      ? issues
      : issues.filter((issue) => !hiddenProjectIdSet.has(issue.projectId))
  ), [hiddenProjectIdSet, issues, resolvedProjectId]);
  const ownerOptionsByProjectId = useMemo(() => {
    const result = new Map<string, IssueOwnerOption[]>();
    for (const project of projects) {
      const members = project.collaboration?.members ?? [];
      if (members.length === 0) {
        continue;
      }
      const options = members.map((member) => ({
        userId: member.userId,
        label: member.label,
        projectName: member.projectName ?? member.project?.name,
      }));
      for (const member of members) {
        result.set(member.projectId, options);
      }
    }
    return result;
  }, [projects]);
  const issueCount = visibleIssues.length;
  const title = currentProject
    ? `${currentProject.name} (${issueCount} ${issueCount === 1 ? 'issue' : 'issues'})`
    : 'Issues';
  const shouldWaitForProjects = !hasRequestedProjects || (isProjectsLoading && projects.length === 0);
  const shouldWaitForProjectResolution = Boolean(projectIdFromUrl) && shouldWaitForProjects;
  const pendingIssue = useMemo(
    () => issues.find((issue) => issue.id === pendingIssueStart?.issueId) ?? null,
    [pendingIssueStart?.issueId, issues],
  );
  const pendingIssueInitialBackend = pickIssueBackend(pendingIssue);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const updateViewport = () => {
      setIsDesktop(mediaQuery.matches);
    };

    updateViewport();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateViewport);
      return () => mediaQuery.removeEventListener('change', updateViewport);
    }

    mediaQuery.addListener(updateViewport);
    return () => mediaQuery.removeListener(updateViewport);
  }, []);

  useEffect(() => {
    if (shouldWaitForProjectResolution || !projectIdFromUrl || resolvedProjectId) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('projectId');
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `/app/issues?${nextQuery}` : '/app/issues', { scroll: false });
  }, [projectIdFromUrl, resolvedProjectId, router, searchParams, shouldWaitForProjectResolution]);

  useEffect(() => {
    if (shouldWaitForProjectResolution) {
      return;
    }
    setSelectedProjectId(resolvedProjectId ?? null);
    void fetchIssues(resolvedProjectId);
  }, [fetchIssues, resolvedProjectId, setSelectedProjectId, shouldWaitForProjectResolution]);

  const handleRefresh = () => {
    void fetchIssues(resolvedProjectId);
  };

  const handleMoveIssue = async (
    issueId: string,
    status: IssueStatus,
    position: number,
    placement: IssueMovePlacement = { mode: 'append' },
  ) => {
    const issue = issues.find((entry) => entry.id === issueId) ?? null;
    if (!issue) {
      return false;
    }

    const shouldSelectBackend =
      issue.status === 'todo'
      && status === 'doing'
      && !issue.activeTask
      && !issue.linkedTask;

    if (shouldSelectBackend) {
      const project = projects.find((entry) => entry.id === issue.projectId) ?? null;
      const availableBackends = getIssueBackendOptions(project, agents);
      if (availableBackends.length > 0) {
        setPendingIssueStart({
          issueId,
          status,
          placement,
          availableBackends,
        });
        return false;
      }
    }

    try {
      await moveIssue(issueId, status, position);
      return true;
    } catch (error) {
      pushToast({
        title: 'Issue move failed',
        description: error instanceof Error ? error.message : 'Failed to update issue status.',
        variant: 'error',
      });
      return false;
    }
  };

  const handleStatusChange = async (issueId: string, status: IssueStatus) => {
    const issue = visibleIssues.find((entry) => entry.id === issueId);
    if (!issue || issue.status === status) {
      return;
    }

    const projectIssues = visibleIssues.filter((entry) => entry.projectId === issue.projectId);
    const nextPosition = calculateIssueAppendPosition(projectIssues, status, issueId);
    await handleMoveIssue(issueId, status, nextPosition, getIssueAppendPlacement());
  };

  const handleOwnerChange = async (issueId: string, ownerUserId: string) => {
    try {
      await updateIssue(issueId, { ownerUserId });
      pushToast({
        title: 'Issue owner updated',
        variant: 'success',
      });
    } catch (error) {
      pushToast({
        title: 'Owner update failed',
        description: error instanceof Error ? error.message : 'Failed to update issue owner.',
        variant: 'error',
      });
    }
  };

  const handleDeleteIssue = async (issueId: string) => {
    try {
      await deleteIssue(issueId);
      pushToast({
        title: 'Issue deleted',
        variant: 'success',
      });
    } catch (error) {
      pushToast({
        title: 'Issue deletion failed',
        description: error instanceof Error ? error.message : 'Failed to delete issue.',
        variant: 'error',
      });
    }
  };

  const handleConfirmIssueStart = async (backendType: string) => {
    if (!pendingIssueStart) {
      return;
    }

    const issue = issues.find((entry) => entry.id === pendingIssueStart.issueId) ?? null;
    if (!issue) {
      setPendingIssueStart(null);
      return;
    }

    try {
      const projectIssues = issues.filter((entry) => entry.projectId === issue.projectId);
      const nextPosition = calculateIssuePositionFromPlacement(
        projectIssues,
        pendingIssueStart.status,
        pendingIssueStart.placement,
        issue.id,
      );
      await updateIssue(issue.id, {
        status: pendingIssueStart.status,
        position: nextPosition,
        metadata: {
          ...(issue.metadata ?? {}),
          backendType,
        },
      });
      setPendingIssueStart(null);
    } catch (error) {
      pushToast({
        title: 'Issue move failed',
        description: error instanceof Error ? error.message : 'Failed to update issue status.',
        variant: 'error',
      });
    }
  };

  return (
    <>
      <Header
        title={title}
        compact
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={isIssuesLoading || shouldWaitForProjectResolution}
              aria-label={isIssuesLoading ? 'Refreshing issues' : 'Refresh issues'}
              title={isIssuesLoading ? 'Refreshing issues' : 'Refresh issues'}
              className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshIcon spinning={isIssuesLoading} />
            </button>
            <button
              onClick={() => setShowCreateDialog(true)}
              aria-label="Create issue"
              title="Create issue"
              disabled={shouldWaitForProjectResolution}
              className="webapp-btn-primary flex items-center justify-center p-2.5 text-sm disabled:opacity-50"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-hidden px-4 pb-4 pt-4">
        {shouldWaitForProjectResolution ? (
          <div className="flex h-full min-h-[24rem] items-center justify-center rounded-[28px] border border-border bg-panel/60">
            <RefreshIcon spinning />
          </div>
        ) : !isDesktop ? (
          <IssueList
            issues={visibleIssues}
            onStatusChange={handleStatusChange}
            ownerOptionsByProjectId={ownerOptionsByProjectId}
            onOwnerChange={handleOwnerChange}
            onDeleteIssue={handleDeleteIssue}
          />
        ) : (
          <IssueBoard
            issues={visibleIssues}
            isLoading={isIssuesLoading}
            dragDisabled={!resolvedProjectId}
            onMoveIssue={handleMoveIssue}
            onStatusChange={handleStatusChange}
            ownerOptionsByProjectId={ownerOptionsByProjectId}
            onOwnerChange={handleOwnerChange}
            onDeleteIssue={handleDeleteIssue}
          />
        )}
      </div>

      <CreateIssueDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        projectId={resolvedProjectId}
      />

      <MoveIssueToDoingDialog
        open={Boolean(pendingIssueStart)}
        availableBackends={pendingIssueStart?.availableBackends ?? []}
        initialBackend={pendingIssueInitialBackend}
        onClose={() => setPendingIssueStart(null)}
        onConfirm={handleConfirmIssueStart}
      />
    </>
  );
}

export default function IssuesPage() {
  return (
    <Suspense fallback={null}>
      <IssuesPageContent />
    </Suspense>
  );
}
