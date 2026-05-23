import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import {
  getAccessibleProjectIds,
  getUserProjectForCollaboration,
  isAssignableIssueOwner,
} from '@/lib/collaboration/service';
import { db } from '@/lib/db';
import {
  createAiTaskArtifacts,
  finalizeAiTaskCreation,
} from '@/lib/tasks/create-ai-task';
import {
  finalizeInplaceTaskRestart,
  planInplaceTaskRestart,
  restartTaskInPlace,
  type PlannedInplaceTaskRestart,
} from '@/lib/tasks/inplace-restart';
import { serializeTaskResponse } from '@/lib/tasks/serialization';
import { normalizeOptionalString, normalizeTaskStatus, type JsonObject } from '@/lib/tasks/task-config';
import { resolveTaskStopTargetHost, stopTaskBeforeRelaunch } from '@/lib/tasks/task-stop';
import { buildTaskWorktreeLaunchConfig } from '@/lib/tasks/worktree';
import {
  ConnectedAgent,
  normalizeBackendType,
  pickDefaultAgentHost,
} from '@/lib/tasks/pty-runtime';
import { realtimeHub } from '@/lib/realtime/hub';
import { normalizeIssuePriority, normalizeIssueStatus } from '@/lib/issues/config';
import { parseIssueMetadata } from '@/lib/issues/serialization';
import { canMergeProjectsByFields } from '@/lib/projects/grouping';
import { isConductorFireHost } from '@/lib/subscription/plan-limits';
import {
  buildIssueInitialContent,
  getNextIssuePosition,
  ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE,
  isDefaultIssuePriority,
  issuePatchSchema,
  issueSerializationSelect,
  issueSerializationWithPrioritySelect,
  loadIssueTaskMaps,
  normalizeIssuePatchBody,
  serializeIssueWithTasks,
  withIssuePrioritySchemaFallback,
} from '../shared';

const issueSelect = issueSerializationSelect;
const issueSelectWithPriority = issueSerializationWithPrioritySelect;

const issueWithProjectSelect = {
  ...issueSelect,
  project: {
    select: {
      id: true,
      userId: true,
      name: true,
      collaborationId: true,
      daemonHost: true,
      workspacePath: true,
      repoRoot: true,
      worktreeBranch: true,
      lastCommit: true,
      lastCommitAt: true,
      // Needed to verify a cross-daemon `projectChanged` move stays within
      // the same merged group when transitioning to doing.
      gitRemoteUrl: true,
      mergeOptOut: true,
    },
  },
};

const issueWithProjectSelectWithPriority = {
  ...issueSelectWithPriority,
  project: issueWithProjectSelect.project,
};

type IssueSpawnAgentHostResult =
  | {
      ok: true;
      agentHost: string | null;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

const supportsRequestedBackend = (
  supportedBackends: string[] | null | undefined,
  requestedBackendType: string | null,
): boolean => {
  if (!requestedBackendType) {
    return true;
  }
  const normalizedBackends = Array.isArray(supportedBackends) ? supportedBackends : [];
  return normalizedBackends.length === 0 || normalizedBackends.includes(requestedBackendType);
};

const pickCompatibleIssueAgentHost = (
  agents: ConnectedAgent[],
  requestedBackendType: string | null,
): string | null => {
  if (!requestedBackendType) {
    return pickDefaultAgentHost(agents, null) ?? null;
  }

  const findHost = (predicate: (agent: ConnectedAgent) => boolean): string | null =>
    agents.find(predicate)?.host ?? null;

  return (
    findHost(
      (agent) =>
        !isConductorFireHost(agent.host)
        && Array.isArray(agent.supportedBackends)
        && agent.supportedBackends.includes(requestedBackendType),
    )
    || findHost(
      (agent) =>
        Array.isArray(agent.supportedBackends)
        && agent.supportedBackends.includes(requestedBackendType),
    )
    || findHost(
      (agent) =>
        !isConductorFireHost(agent.host)
        && supportsRequestedBackend(agent.supportedBackends, requestedBackendType),
    )
    || findHost((agent) => supportsRequestedBackend(agent.supportedBackends, requestedBackendType))
  );
};

const resolveIssueSpawnAgentHost = (args: {
  connectedAgents: ConnectedAgent[];
  projectDaemonHost: string | null;
  requestedBackendType: string | null;
  /**
   * Daemon the client explicitly picked in the MoveIssueToDoing dialog
   * (forwarded via `metadata.daemonHost`). When the project is bound to a
   * daemon, the request and the binding must agree. When the project is
   * unbound (default project), the explicit pick wins over the auto-pick
   * fallback — otherwise the picker the user sees is cosmetic.
   */
  requestedDaemonHost: string | null;
}): IssueSpawnAgentHostResult => {
  if (args.projectDaemonHost) {
    if (args.requestedDaemonHost && args.requestedDaemonHost !== args.projectDaemonHost) {
      return {
        ok: false,
        error: `Requested daemon ${args.requestedDaemonHost} does not match the project's bound daemon ${args.projectDaemonHost}`,
        status: 409,
      };
    }
    const projectAgent = args.connectedAgents.find((agent) => agent.host === args.projectDaemonHost) ?? null;
    if (!projectAgent) {
      return {
        ok: false,
        error: `Project daemon ${args.projectDaemonHost} is offline`,
        status: 409,
      };
    }

    if (!args.requestedBackendType) {
      return {
        ok: true,
        agentHost: args.projectDaemonHost,
      };
    }

    if (!supportsRequestedBackend(projectAgent.supportedBackends, args.requestedBackendType)) {
      return {
        ok: false,
        error: `Daemon ${args.projectDaemonHost} does not support backend ${args.requestedBackendType}`,
        status: 409,
      };
    }

    return {
      ok: true,
      agentHost: args.projectDaemonHost,
    };
  }

  // Unbound project (e.g. default project). If the client explicitly chose a
  // daemon, that choice wins — checking online + backend compatibility — so
  // the dialog's daemon picker actually controls where the task spawns.
  if (args.requestedDaemonHost) {
    const requestedAgent = args.connectedAgents.find((agent) => agent.host === args.requestedDaemonHost) ?? null;
    if (!requestedAgent) {
      return {
        ok: false,
        error: `Daemon ${args.requestedDaemonHost} is offline`,
        status: 409,
      };
    }
    if (!supportsRequestedBackend(requestedAgent.supportedBackends, args.requestedBackendType)) {
      return {
        ok: false,
        error: `Daemon ${args.requestedDaemonHost} does not support backend ${args.requestedBackendType ?? '(unspecified)'}`,
        status: 409,
      };
    }
    return {
      ok: true,
      agentHost: args.requestedDaemonHost,
    };
  }

  if (!args.requestedBackendType) {
    return {
      ok: true,
      agentHost: pickDefaultAgentHost(args.connectedAgents, null) ?? null,
    };
  }

  const agentHost = pickCompatibleIssueAgentHost(args.connectedAgents, args.requestedBackendType);
  if (!agentHost) {
    return {
      ok: false,
      error: `No compatible daemon online for backend ${args.requestedBackendType}`,
      status: 409,
    };
  }

  const selectedAgent = args.connectedAgents.find((agent) => agent.host === agentHost) ?? null;
  if (!supportsRequestedBackend(selectedAgent?.supportedBackends, args.requestedBackendType)) {
    return {
      ok: false,
      error: `No compatible daemon online for backend ${args.requestedBackendType}`,
      status: 409,
    };
  }

  return {
    ok: true,
    agentHost,
  };
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { issueId } = await params;
  const accessibleProjectIds = await getAccessibleProjectIds(user.id);
  const { result: issue } = await withIssuePrioritySchemaFallback(
    'issues.detail',
    () => db.issue.findFirst({
      where: {
        id: issueId,
        projectId: { in: accessibleProjectIds },
      },
      select: issueSelectWithPriority,
    }),
    () => db.issue.findFirst({
      where: {
        id: issueId,
        projectId: { in: accessibleProjectIds },
      },
      select: issueSelect,
    }),
  );

  if (!issue) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { activeTaskByIssueId, linkedTaskByIssueId, tasksByIssueId } = await loadIssueTaskMaps(user.id, [issue.id]);

  return NextResponse.json(serializeIssueWithTasks(issue, {
    activeTask: activeTaskByIssueId.get(issue.id) ?? null,
    linkedTask: linkedTaskByIssueId.get(issue.id) ?? null,
    tasks: tasksByIssueId.get(issue.id) ?? null,
  }));
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { issueId } = await params;
  const accessibleProjectIds = await getAccessibleProjectIds(user.id);
  const { result: existing, prioritySchemaAvailable } = await withIssuePrioritySchemaFallback(
    'issues.patch.load',
    () => db.issue.findFirst({
      where: {
        id: issueId,
        projectId: { in: accessibleProjectIds },
      },
      select: issueWithProjectSelectWithPriority,
    }),
    () => db.issue.findFirst({
      where: {
        id: issueId,
        projectId: { in: accessibleProjectIds },
      },
      select: issueWithProjectSelect,
    }),
  );

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { activeTaskByIssueId, linkedTaskByIssueId, tasksByIssueId } = await loadIssueTaskMaps(user.id, [existing.id]);

  const body = await request.json().catch(() => null);
  const parsed = issuePatchSchema.safeParse(normalizeIssuePatchBody(body));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const existingMetadata = parseIssueMetadata(existing.metadata);
  const nextMetadata = input.metadata !== undefined ? input.metadata : existingMetadata;
  const requestedBackendType = normalizeBackendType(nextMetadata?.backendType);
  // The doing dialog passes the user-selected daemon through metadata so the
  // server can (a) honor it on unbound projects where projectDaemonHost is
  // null, and (b) detect a conflict with a project-bound daemon. We only read
  // it; the value persisted back to metadata is rewritten below with the
  // actually-resolved agentHost so a fake client value never sticks.
  const requestedDaemonHost = typeof nextMetadata?.daemonHost === 'string'
    ? (normalizeOptionalString(nextMetadata.daemonHost) ?? null)
    : null;
  const currentStatus = normalizeIssueStatus(existing.status);
  const currentPriority = normalizeIssuePriority(
    'priority' in existing ? existing.priority : undefined,
  );
  const nextStatus = input.status ?? currentStatus;
  const nextPriority = input.priority ?? currentPriority;
  const issueProjectOwnerId = existing.project.userId ?? user.id;
  const issueProjectCollaborationId = existing.project.collaborationId ?? null;
  const currentOwnerUserId = existing.ownerUserId ?? issueProjectOwnerId;
  const nextProjectId = input.projectId ?? existing.projectId;
  const projectChanged = input.projectId !== undefined && input.projectId !== existing.projectId;
  let targetProject = existing.project;
  if (projectChanged) {
    // Re-parenting a *running* issue is still forbidden — the active task is
    // glued to its daemon and worktree. The newly-allowed case is the
    // todo→doing transition for merged-group siblings: the issue had no
    // committed daemon yet, and the user picks one in the MoveIssueToDoing
    // dialog. We validate that below by checking `canMergeProjectsByFields`.
    if (currentStatus === 'doing') {
      return NextResponse.json({ error: 'Move the issue out of doing before changing target project' }, { status: 409 });
    }
    if (currentOwnerUserId !== user.id && issueProjectOwnerId !== user.id) {
      return NextResponse.json(
        { error: 'Only the current issue owner or the project owner can change this issue target project' },
        { status: 403 },
      );
    }
    if (!accessibleProjectIds.includes(nextProjectId)) {
      return NextResponse.json({ error: 'Target project not found' }, { status: 404 });
    }
    const requestedProject = await db.project.findFirst({
      where: {
        id: nextProjectId,
      },
      select: issueWithProjectSelect.project.select,
    });
    if (!requestedProject) {
      return NextResponse.json({ error: 'Target project not found' }, { status: 404 });
    }
    const sameCollaboration =
      issueProjectCollaborationId &&
      requestedProject.collaborationId === issueProjectCollaborationId;
    const ownStandaloneMove =
      !issueProjectCollaborationId &&
      !requestedProject.collaborationId &&
      requestedProject.userId === user.id;
    if (!sameCollaboration && !ownStandaloneMove) {
      return NextResponse.json(
        { error: 'Target project must belong to the same collaboration' },
        { status: 400 },
      );
    }
    if (nextStatus === 'doing') {
      // Re-parent + spawn means we will execute the task on `targetProject`'s
      // daemon. That daemon must belong to the current user — otherwise we
      // would be asking the realtime hub to talk to another member's daemon
      // (which today fails with a misleading "daemon offline" because
      // `getAgentsForUser` is per-user, but the right error is "not yours").
      // Forbid the request explicitly so the boundary stays clear even if
      // anyone widens the per-user agent scope later.
      if (requestedProject.userId !== user.id) {
        return NextResponse.json(
          { error: 'Target project must belong to the current user to start work on its daemon' },
          { status: 403 },
        );
      }
      // The only sanctioned reason to switch project IDs while *entering*
      // doing is the cross-daemon merged group — the client is committing to
      // a daemon for the first time. Reject any other reshuffle here so a
      // mis-configured client cannot smuggle the issue into an unrelated
      // project as a side effect of "start work."
      const isSibling = canMergeProjectsByFields(
        {
          name: existing.project.name,
          daemonHost: existing.project.daemonHost,
          gitRemoteUrl: existing.project.gitRemoteUrl,
          mergeOptOut: existing.project.mergeOptOut,
        },
        {
          name: requestedProject.name,
          daemonHost: requestedProject.daemonHost,
          gitRemoteUrl: requestedProject.gitRemoteUrl,
          mergeOptOut: requestedProject.mergeOptOut,
        },
      );
      if (!isSibling) {
        return NextResponse.json(
          { error: 'Target project must be a cross-daemon sibling of the current project to start work there' },
          { status: 409 },
        );
      }
      // A linked task implies a worktree + session already live on the
      // original daemon. Restarting it on a different daemon would orphan the
      // PTY session, so refuse and tell the user to clean up first.
      if (linkedTaskByIssueId.get(existing.id)) {
        return NextResponse.json(
          { error: 'A linked task already exists on the original daemon. Clear it before starting work on a different daemon.' },
          { status: 409 },
        );
      }
    }
    targetProject = requestedProject;
    if (nextStatus === 'doing') {
      // Breadcrumb for "my issue jumped daemons" debugging — fires only on
      // the merged-group sibling switch path.
      console.info(
        `[issues] re-parent on doing transition: issue=${existing.id} userId=${user.id} from=${existing.projectId}(${existing.project.daemonHost ?? '-'}) to=${requestedProject.id}(${requestedProject.daemonHost ?? '-'})`,
      );
    }
  }
  const nextOwnerUserId = input.ownerUserId ?? currentOwnerUserId;
  if ((input.ownerUserId || projectChanged) && !(await isAssignableIssueOwner(targetProject, nextOwnerUserId))) {
    return NextResponse.json({ error: 'Issue owner is not a collaboration member' }, { status: 400 });
  }
  const ownerChanged = input.ownerUserId !== undefined && input.ownerUserId !== currentOwnerUserId;
  // Only the current issue owner or the host project's owner may reassign
  // ownership. Without this guard a collaborator could two-step `{ ownerUserId:
  // self }` then `{ status: 'doing' }` to silently steal another member's
  // issue and spawn a task on their own daemon.
  if (ownerChanged && currentOwnerUserId !== user.id && issueProjectOwnerId !== user.id) {
    return NextResponse.json(
      { error: 'Only the current issue owner or the project owner can reassign this issue' },
      { status: 403 },
    );
  }
  if (ownerChanged && (currentStatus === 'doing' || nextStatus === 'doing')) {
    return NextResponse.json({ error: 'Move the issue out of doing before changing owner' }, { status: 409 });
  }
  if (currentStatus !== 'doing' && nextStatus === 'doing' && nextOwnerUserId !== user.id) {
    return NextResponse.json({ error: 'Only the issue owner can move this issue into doing' }, { status: 409 });
  }
  if (currentStatus === 'doing' && nextStatus !== 'doing' && currentOwnerUserId !== user.id) {
    return NextResponse.json({ error: 'Only the issue owner can change a running issue status' }, { status: 409 });
  }
  if (!prioritySchemaAvailable && input.priority !== undefined && !isDefaultIssuePriority(input.priority)) {
    return NextResponse.json(
      { error: ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE },
      { status: 409 },
    );
  }
  const nextPosition = typeof input.position === 'number'
    ? input.position
    : nextStatus !== currentStatus || projectChanged
      ? await getNextIssuePosition(nextProjectId, nextStatus)
      : existing.position;
  const shouldEnterDoing = currentStatus !== 'doing' && nextStatus === 'doing';

  let activeTask: Parameters<typeof serializeTaskResponse>[0] | null =
    activeTaskByIssueId.get(existing.id) ?? null;
  let linkedTask: Parameters<typeof serializeTaskResponse>[0] | null =
    linkedTaskByIssueId.get(existing.id) ?? activeTask;
  const shouldManageLocalTask = nextOwnerUserId === user.id;
  const shouldRestartLinkedTask = shouldManageLocalTask && shouldEnterDoing && !activeTask && Boolean(linkedTask);
  const shouldSpawnTask = shouldManageLocalTask && shouldEnterDoing && !activeTask && !linkedTask;
  const shouldKillActiveTask = currentStatus === 'doing' && nextStatus === 'done' && Boolean(activeTask);
  let killedTask: Parameters<typeof serializeTaskResponse>[0] | null = null;
  let spawnedTask: Awaited<ReturnType<typeof createAiTaskArtifacts>> | null = null;
  let spawnTaskArgs: Parameters<typeof createAiTaskArtifacts>[0] | null = null;
  let restartPlan: PlannedInplaceTaskRestart | null = null;

  if (shouldSpawnTask && !activeTask) {
    // When the client just chose a merged-group sibling in the doing dialog,
    // `targetProject` already points at the daemon the user selected — use it
    // verbatim so the spawn lands on the new daemon. For the unchanged path,
    // fall back to the existing owner/collaboration resolution.
    const executionProject = projectChanged
      ? targetProject
      : (issueProjectOwnerId === user.id
        ? existing.project
        : issueProjectCollaborationId
          ? (await getUserProjectForCollaboration(user.id, issueProjectCollaborationId))?.project ?? null
          : null);
    if (!executionProject) {
      return NextResponse.json({ error: 'No local project available for this collaboration' }, { status: 409 });
    }

    const defaultProject = await db.defaultProject.findUnique({
      where: { userId: user.id },
      select: { projectId: true },
    });
    const isDefaultProject = defaultProject?.projectId === executionProject.id;
    const projectDaemonHost = normalizeOptionalString(executionProject.daemonHost);
    const projectWorkspacePath = normalizeOptionalString(executionProject.workspacePath);
    const projectRepoRoot = normalizeOptionalString(executionProject.repoRoot);
    const projectWorktreeBranch = normalizeOptionalString(executionProject.worktreeBranch);
    const projectLastCommit = normalizeOptionalString(executionProject.lastCommit);

    if (
      (!isDefaultProject && (!projectDaemonHost || !projectWorkspacePath)) ||
      (projectDaemonHost && !projectWorkspacePath) ||
      (!projectDaemonHost && projectWorkspacePath)
    ) {
      return NextResponse.json({ error: 'Project binding incomplete' }, { status: 409 });
    }

    const connectedAgents = realtimeHub.getAgentsForUser(user.id) as ConnectedAgent[];
    const resolvedAgentHost = resolveIssueSpawnAgentHost({
      connectedAgents,
      projectDaemonHost,
      requestedBackendType,
      requestedDaemonHost,
    });
    if (!resolvedAgentHost.ok) {
      return NextResponse.json(
        { error: resolvedAgentHost.error },
        { status: resolvedAgentHost.status },
      );
    }

    const agentHost = resolvedAgentHost.agentHost;
    const initialContent = buildIssueInitialContent({
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
    });
    const metadata = {
      ...(requestedBackendType ? { backendType: requestedBackendType } : {}),
      ...(initialContent ? { initialContent } : {}),
    };
    let requestedTaskId: string | undefined;
    let launchConfig: JsonObject | null = null;
    if (projectWorkspacePath) {
      if (projectRepoRoot) {
        requestedTaskId = randomUUID();
        try {
          launchConfig = buildTaskWorktreeLaunchConfig({
            launchConfig: null,
            worktreeId: requestedTaskId,
            projectRepoRoot,
            projectWorkspacePath,
            projectWorktreeBranch,
            projectLastCommit,
          });
        } catch (error) {
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Invalid worktree request' },
            { status: 409 },
          );
        }
      } else {
        launchConfig = {
          cwd: projectWorkspacePath,
          ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
        };
      }
    }

    spawnTaskArgs = {
      userId: user.id,
      projectId: executionProject.id,
      issueId: existing.id,
      title: input.title ?? existing.title,
      agentHost,
      requestedBackendType,
      requestedId: requestedTaskId,
      launchConfig,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      initialMessageContent: initialContent,
    };
  }

  if (shouldRestartLinkedTask && linkedTask) {
    const executionProject = issueProjectOwnerId === user.id
      ? existing.project
      : issueProjectCollaborationId
        ? (await getUserProjectForCollaboration(user.id, issueProjectCollaborationId))?.project ?? null
        : null;
    if (!executionProject) {
      return NextResponse.json({ error: 'No local project available for this collaboration' }, { status: 409 });
    }
    const connectedAgents = realtimeHub.getAgentsForUser(user.id) as ConnectedAgent[];
    const restartPlanResult = planInplaceTaskRestart({
      sourceTask: linkedTask,
      project: executionProject,
      connectedAgents,
    });
    if (!restartPlanResult.ok) {
      return NextResponse.json({ error: restartPlanResult.error }, { status: restartPlanResult.status });
    }
    restartPlan = restartPlanResult.plan;
  }

  if (shouldKillActiveTask && activeTask) {
    const normalizedTaskStatus = normalizeTaskStatus(activeTask.status);
    const shouldStopTask =
      normalizedTaskStatus === 'init' ||
      normalizedTaskStatus === 'running' ||
      normalizedTaskStatus === 'killing' ||
      normalizedTaskStatus === 'unknown';
    const stopTargetHost = shouldStopTask
      ? resolveTaskStopTargetHost({
          taskId: activeTask.id,
          executionHost: activeTask.executionHost,
          agentHost: activeTask.agentHost,
        }) || null
      : null;

    if (shouldStopTask && stopTargetHost) {
      const stopResult = await stopTaskBeforeRelaunch({
        userId: user.id,
        taskId: activeTask.id,
        projectId: activeTask.projectId,
        stopTargetHost,
        reason: 'issue_done',
        taskLabel: 'issue task',
      });
      if (!stopResult.ok) {
        return NextResponse.json(
          { error: stopResult.error ?? 'Failed to stop issue task' },
          { status: 409 },
        );
      }
    }

    if (shouldStopTask && !stopTargetHost) {
      return NextResponse.json(
        { error: 'Issue task missing active daemon binding' },
        { status: 409 },
      );
    }

    if (shouldStopTask) {
      const latestTask = await db.task.findFirst({
        where: {
          id: activeTask.id,
          project: { userId: user.id },
        },
      });
      if (!latestTask) {
        return NextResponse.json({ error: 'Issue task not found after stop' }, { status: 409 });
      }
      const normalizedLatestTaskStatus = normalizeTaskStatus(latestTask.status);
      if (normalizedLatestTaskStatus !== 'completed' && normalizedLatestTaskStatus !== 'killed') {
        return NextResponse.json(
          { error: 'Issue task stop did not reach a terminal state' },
          { status: 409 },
        );
      }
      activeTask = latestTask;
      linkedTask = latestTask;
    }
  }

  // When the client supplied `metadata.daemonHost` (the "remember last daemon"
  // hint set by the doing dialog), make the server the source of truth for
  // what actually ran: replace the value with the daemon we resolved above.
  // Without this an SDK/CLI client could PATCH `metadata.daemonHost: "fake"`
  // and the issue would silently advertise the wrong machine next time.
  const effectiveDaemonHost = spawnTaskArgs?.agentHost
    ?? restartPlan?.restartAgentHost
    ?? null;
  if (shouldEnterDoing && input.metadata !== undefined && input.metadata !== null) {
    if (effectiveDaemonHost) {
      input.metadata = { ...input.metadata, daemonHost: effectiveDaemonHost };
    } else if ('daemonHost' in input.metadata) {
      // Doing transition that doesn't actually spawn/restart (e.g., the issue
      // already had an active task and we skip both paths) — drop the hint so
      // we don't persist a value nothing on the server validated.
      const { daemonHost: _dropped, ...rest } = input.metadata;
      input.metadata = rest;
    }
  }

  const issueUpdateData = {
    projectId: nextProjectId,
    ownerUserId: nextOwnerUserId,
    title: input.title ?? existing.title,
    description: input.description !== undefined ? input.description : existing.description,
    status: nextStatus,
    position: nextPosition,
    metadata: input.metadata !== undefined
      ? (input.metadata ? JSON.stringify(input.metadata) : null)
      : existing.metadata,
  };
  const issueUpdateArgs = {
    where: { id: existing.id },
    data: {
      ...issueUpdateData,
      priority: nextPriority,
    },
    select: issueSelectWithPriority,
  };
  const issueUpdateArgsWithoutPriority = {
    where: { id: existing.id },
    data: issueUpdateData,
    select: issueSelect,
  };
  const effectiveIssueUpdateArgs = prioritySchemaAvailable
    ? issueUpdateArgs
    : issueUpdateArgsWithoutPriority;

  let updated;
  if (shouldRestartLinkedTask && linkedTask && restartPlan) {
    const restartSourceTask = linkedTask;
    const transactionResult = await db.$transaction(async (tx: any) => {
      const claimed = await tx.issue.updateMany({
        where: {
          id: existing.id,
          status: existing.status,
        },
        data: {
          status: 'doing',
        },
      });

      if (claimed.count === 0) {
        const updatedIssue = await tx.issue.update(effectiveIssueUpdateArgs);
        return {
          restartedTask: null,
          updatedIssue,
          skippedRestart: true,
        };
      }

      const restartedTask = await restartTaskInPlace({
        tx,
        userId: user.id,
        sourceTask: restartSourceTask,
        plan: restartPlan,
      });
      const updatedIssue = await tx.issue.update(effectiveIssueUpdateArgs);
      return {
        restartedTask,
        updatedIssue,
        skippedRestart: false,
      };
    });

    if (!transactionResult.skippedRestart && transactionResult.restartedTask) {
      activeTask = transactionResult.restartedTask.task;
      linkedTask = transactionResult.restartedTask.task;
      await finalizeInplaceTaskRestart({
        userId: user.id,
        taskId: transactionResult.restartedTask.task.id,
        restartAgentHost: transactionResult.restartedTask.restartAgentHost,
      });
    }

    updated = transactionResult.updatedIssue;
  } else if (spawnTaskArgs) {
    const transactionResult = await db.$transaction(async (tx: any) => {
      const claimed = await tx.issue.updateMany({
        where: {
          id: existing.id,
          status: existing.status,
        },
        data: {
          status: 'doing',
        },
      });

      if (claimed.count === 0) {
        const updatedIssue = await tx.issue.update(effectiveIssueUpdateArgs);
        return {
          createdTask: null,
          updatedIssue,
          skippedSpawn: true,
        };
      }

      // We own the transition — safe to spawn the task
      const createdTask = await createAiTaskArtifacts(spawnTaskArgs!, tx);
      const updatedIssue = await tx.issue.update(effectiveIssueUpdateArgs);
      return {
        createdTask,
        updatedIssue,
        skippedSpawn: false,
      };
    });

    if (!transactionResult.skippedSpawn && transactionResult.createdTask) {
      spawnedTask = transactionResult.createdTask;
      activeTask = transactionResult.createdTask.task;
      linkedTask = transactionResult.createdTask.task;

      await finalizeAiTaskCreation({
        ...spawnTaskArgs,
        ...transactionResult.createdTask,
      });
    }
    updated = transactionResult.updatedIssue;
  } else if (shouldKillActiveTask && activeTask) {
    const transactionResult = await db.$transaction(async (tx: any) => {
      const updatedIssue = await tx.issue.update(effectiveIssueUpdateArgs);
      return {
        updatedIssue,
        updatedTask: activeTask,
      };
    });
    updated = transactionResult.updatedIssue;
    killedTask = transactionResult.updatedTask;
    linkedTask = transactionResult.updatedTask;
    activeTask = null;
  } else {
    updated = await db.issue.update(effectiveIssueUpdateArgs);
  }

  const existingTasks = tasksByIssueId.get(existing.id) ?? [];
  type IssueTaskEntry = typeof existingTasks[number];
  const getTaskSortTime = (task: IssueTaskEntry): number =>
    (task.updatedAt instanceof Date ? task.updatedAt : task.createdAt).getTime();
  const tasksById = new Map<string, IssueTaskEntry>();
  for (const task of existingTasks) {
    if (task && typeof task.id === 'string') {
      tasksById.set(task.id, task);
    }
  }
  for (const extra of [activeTask, linkedTask, spawnedTask?.task ?? null, killedTask]) {
    if (extra && typeof extra.id === 'string') {
      tasksById.set(extra.id, extra as IssueTaskEntry);
    }
  }
  const nextTasks = Array.from(tasksById.values()).sort(
    (left, right) => getTaskSortTime(right) - getTaskSortTime(left),
  );

  const serializedIssue = serializeIssueWithTasks(updated, {
    activeTask,
    linkedTask,
    tasks: nextTasks,
  });
  const serializedActiveTask = activeTask ? serializeTaskResponse(activeTask) : null;
  const serializedLinkedTask = linkedTask ? serializeTaskResponse(linkedTask) : null;
  const serializedSpawnedTask = spawnedTask ? serializeTaskResponse(spawnedTask.task) : null;
  const serializedKilledTask = killedTask ? serializeTaskResponse(killedTask) : null;

  return NextResponse.json({
    issue: serializedIssue,
    activeTask: serializedActiveTask,
    active_task: serializedActiveTask,
    linkedTask: serializedLinkedTask,
    linked_task: serializedLinkedTask,
    spawnedTask: serializedSpawnedTask,
    spawned_task: serializedSpawnedTask,
    killedTask: serializedKilledTask,
    killed_task: serializedKilledTask,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { issueId } = await params;
  const existing = await db.issue.findFirst({
    where: {
      id: issueId,
      projectId: { in: await getAccessibleProjectIds(user.id) },
    },
    select: issueSelect,
  });

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (normalizeIssueStatus(existing.status) === 'doing') {
    return NextResponse.json({ error: 'Move the issue out of doing before deleting it' }, { status: 409 });
  }

  await db.issue.delete({ where: { id: issueId } });
  return new NextResponse(null, { status: 204 });
}
