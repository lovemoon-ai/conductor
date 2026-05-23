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
import type { MoveIssueToDoingDaemonOption } from '@/features/issues/components/MoveIssueToDoingDialog';
import { useProjectsStore } from '@/features/projects';
import { canMergeProjects, computeProjectGroups } from '@/features/projects/utils/project-groups';
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

const normalizeHost = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

const pickIssueBackend = (issue: Issue | null): string | null => {
  if (!issue?.metadata || typeof issue.metadata.backendType !== 'string') {
    return null;
  }
  const backendType = issue.metadata.backendType.trim();
  return backendType || null;
};

/**
 * Resolve the daemon the dialog should default to. Priority order:
 *  1. Last daemon the issue was successfully sent to (`metadata.daemonHost`).
 *     Survives across todo→done→todo cycles so the user does not have to
 *     re-pick the same machine every time.
 *  2. The issue's current project's `daemonHost`. For non-merged projects this
 *     is the only candidate; for merged groups it is "where the issue lives
 *     right now" — typically the same machine as the most recent run.
 */
const pickIssueDaemon = (issue: Issue | null, project: Project | null): string | null => {
  const fromMetadata = typeof issue?.metadata?.daemonHost === 'string'
    ? issue.metadata.daemonHost.trim()
    : '';
  if (fromMetadata) {
    return fromMetadata;
  }
  const fromProject = normalizeHost(project?.daemonHost);
  return fromProject || null;
};

/**
 * Build the daemon picker option list shown when transitioning a todo issue to
 * doing. The shape of the list depends on the project kind:
 *
 *  - Default project: no fixed daemon binding, so every online non-fire daemon
 *    is offered as an option. The underlying `projectId` does not change.
 *  - Bound project: list every cross-daemon merged-group sibling whose daemon
 *    is currently online. Picking a sibling will re-parent the issue from its
 *    current daemon's project to the chosen daemon's project. Issues that
 *    live in a merged group are deliberately NOT pinned to a specific daemon
 *    until the user makes this choice — the daemon binding lives on the
 *    task, not on the issue. (See the issue route's `projectChanged` branch
 *    for the server-side enforcement of the same rule.)
 */
const getIssueDaemonOptions = (
  project: Project | null,
  projects: Project[],
  agents: Agent[],
): MoveIssueToDoingDaemonOption[] => {
  if (!project) {
    return [];
  }

  const seenHost = new Set<string>();
  const options: MoveIssueToDoingDaemonOption[] = [];

  if (project.isDefault) {
    for (const agent of agents) {
      const host = normalizeHost(agent.host);
      if (!host || seenHost.has(host) || isConductorFireHost(host)) {
        continue;
      }
      seenHost.add(host);
      options.push({
        host,
        projectId: project.id,
        supportedBackends: [...(agent.supportedBackends ?? [])],
      });
    }
    return options;
  }

  const projectHost = normalizeHost(project.daemonHost);
  if (!projectHost) {
    return [];
  }

  for (const candidate of projects) {
    if (candidate.id !== project.id && !canMergeProjects(project, candidate)) {
      continue;
    }
    const host = normalizeHost(candidate.daemonHost);
    if (!host || seenHost.has(host)) {
      continue;
    }
    const agent = agents.find((entry) => entry.host === host);
    if (!agent) {
      continue;
    }
    seenHost.add(host);
    options.push({
      host,
      projectId: candidate.id,
      supportedBackends: [...(agent.supportedBackends ?? [])],
    });
  }

  return options;
};

type PendingIssueStart = {
  issueId: string;
  status: IssueStatus;
  placement: IssueMovePlacement;
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
  const fetchIssuesForProjects = useIssuesStore((state) => state.fetchIssuesForProjects);
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
  // When the resolved project belongs to a cross-daemon merged group, fetch
  // issues for every member so the board shows them together with daemon
  // attribution. Single-member groups behave exactly as before.
  const projectGroups = useMemo(() => computeProjectGroups(projects), [projects]);
  const currentGroup = useMemo(() => {
    if (!resolvedProjectId) return null;
    return projectGroups.find((group) =>
      group.members.some((member) => member.id === resolvedProjectId),
    ) ?? null;
  }, [projectGroups, resolvedProjectId]);
  const currentGroupMemberIds = useMemo(
    () => (currentGroup ? currentGroup.members.map((member) => member.id) : []),
    [currentGroup],
  );
  const isMergedGroup = currentGroup ? currentGroup.isMerged : false;
  const visibleIssues = useMemo(() => (
    resolvedProjectId
      ? issues
      : issues.filter((issue) => !hiddenProjectIdSet.has(issue.projectId))
  ), [hiddenProjectIdSet, issues, resolvedProjectId]);
  // A project is in "multi-daemon context" — and therefore should show the
  // daemon chip on its issue cards after a commitment — when:
  //   - it has at least one sibling project (merged cross-daemon group), OR
  //   - it is the default project AND 2+ non-fire daemons are connected.
  // Anything else (single-daemon bound project, default with 1 daemon) is
  // single-daemon by definition and the chip stays hidden — per product
  // spec, "issue 不显示 daemon" when there is no real daemon choice to make.
  const multiDaemonProjectIds = useMemo<ReadonlySet<string>>(() => {
    const nonFireOnlineDaemonCount = agents.reduce(
      (count, agent) => (isConductorFireHost(agent.host) ? count : count + 1),
      0,
    );
    const result = new Set<string>();
    for (const project of projects) {
      if (project.isDefault) {
        if (nonFireOnlineDaemonCount > 1) {
          result.add(project.id);
        }
        continue;
      }
      const hasSibling = projects.some(
        (other) => other.id !== project.id && canMergeProjects(project, other),
      );
      if (hasSibling) {
        result.add(project.id);
      }
    }
    return result;
  }, [agents, projects]);
  const ownerOptionsByProjectId = useMemo(() => {
    const result = new Map<string, IssueOwnerOption[]>();
    for (const project of projects) {
      const members = project.collaboration?.members ?? [];
      if (members.length === 0) {
        continue;
      }
      const options = members.map((member) => ({
        userId: member.userId,
        projectId: member.projectId,
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
  const pendingIssueProject = useMemo(
    () => projects.find((entry) => entry.id === pendingIssue?.projectId) ?? null,
    [pendingIssue?.projectId, projects],
  );
  // Recompute the daemon list every render off the live agents/projects
  // stores so that, if a sibling daemon goes offline while the dialog is
  // open, the picker stops offering it instead of relying on a stale
  // snapshot captured at click time.
  const pendingIssueDaemonOptions = useMemo<MoveIssueToDoingDaemonOption[]>(
    () => (pendingIssueProject
      ? getIssueDaemonOptions(pendingIssueProject, projects, agents)
      : []),
    [agents, pendingIssueProject, projects],
  );
  const pendingIssueInitialBackend = pickIssueBackend(pendingIssue);
  const pendingIssueInitialDaemon = pickIssueDaemon(pendingIssue, pendingIssueProject);

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
    if (isMergedGroup && currentGroupMemberIds.length > 1) {
      void fetchIssuesForProjects(currentGroupMemberIds);
    } else {
      void fetchIssues(resolvedProjectId);
    }
  }, [
    currentGroupMemberIds,
    fetchIssues,
    fetchIssuesForProjects,
    isMergedGroup,
    resolvedProjectId,
    setSelectedProjectId,
    shouldWaitForProjectResolution,
  ]);

  const handleRefresh = () => {
    if (isMergedGroup && currentGroupMemberIds.length > 1) {
      void fetchIssuesForProjects(currentGroupMemberIds);
    } else {
      void fetchIssues(resolvedProjectId);
    }
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
      const daemonOptions = getIssueDaemonOptions(project, projects, agents);
      const hasAnyBackend = daemonOptions.some((option) => option.supportedBackends.length > 0);
      if (hasAnyBackend) {
        // We only need to remember which issue + how it was dragged; the
        // dialog re-derives the daemon list every render from live state.
        setPendingIssueStart({ issueId, status, placement });
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

  const handleConfirmIssueStart = async (args: {
    backendType: string;
    daemonHost: string;
    projectId: string;
  }) => {
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
      // Re-parent the issue only when the chosen daemon's project differs.
      // For non-merged projects the picker collapses to a single option whose
      // `projectId` matches the issue's current project, so this branch is a
      // no-op and the request behaves exactly like before.
      const projectChanged = args.projectId !== issue.projectId;
      await updateIssue(issue.id, {
        status: pendingIssueStart.status,
        position: nextPosition,
        ...(projectChanged ? { projectId: args.projectId } : {}),
        metadata: {
          ...(issue.metadata ?? {}),
          backendType: args.backendType,
          daemonHost: args.daemonHost,
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
            multiDaemonProjectIds={multiDaemonProjectIds}
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
            multiDaemonProjectIds={multiDaemonProjectIds}
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
        daemonOptions={pendingIssueDaemonOptions}
        initialDaemon={pendingIssueInitialDaemon}
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
