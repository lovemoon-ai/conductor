import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
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
  pickDefaultAgentHost,
} from '@/lib/tasks/pty-runtime';
import { realtimeHub } from '@/lib/realtime/hub';
import { normalizeIssuePriority, normalizeIssueStatus } from '@/lib/issues/config';
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
      daemonHost: true,
      workspacePath: true,
      repoRoot: true,
      worktreeBranch: true,
      lastCommit: true,
    },
  },
};

const issueWithProjectSelectWithPriority = {
  ...issueSelectWithPriority,
  project: issueWithProjectSelect.project,
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { issueId } = await params;
  const { result: issue } = await withIssuePrioritySchemaFallback(
    'issues.detail',
    () => db.issue.findFirst({
      where: {
        id: issueId,
        project: { userId: user.id },
      },
      select: issueSelectWithPriority,
    }),
    () => db.issue.findFirst({
      where: {
        id: issueId,
        project: { userId: user.id },
      },
      select: issueSelect,
    }),
  );

  if (!issue) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { activeTaskByIssueId, linkedTaskByIssueId } = await loadIssueTaskMaps(user.id, [issue.id]);

  return NextResponse.json(serializeIssueWithTasks(issue, {
    activeTask: activeTaskByIssueId.get(issue.id) ?? null,
    linkedTask: linkedTaskByIssueId.get(issue.id) ?? null,
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
  const { result: existing, prioritySchemaAvailable } = await withIssuePrioritySchemaFallback(
    'issues.patch.load',
    () => db.issue.findFirst({
      where: {
        id: issueId,
        project: { userId: user.id },
      },
      select: issueWithProjectSelectWithPriority,
    }),
    () => db.issue.findFirst({
      where: {
        id: issueId,
        project: { userId: user.id },
      },
      select: issueWithProjectSelect,
    }),
  );

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { activeTaskByIssueId, linkedTaskByIssueId } = await loadIssueTaskMaps(user.id, [existing.id]);

  const body = await request.json().catch(() => null);
  const parsed = issuePatchSchema.safeParse(normalizeIssuePatchBody(body));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const currentStatus = normalizeIssueStatus(existing.status);
  const currentPriority = normalizeIssuePriority(existing.priority);
  const nextStatus = input.status ?? currentStatus;
  const nextPriority = input.priority ?? currentPriority;
  if (!prioritySchemaAvailable && input.priority !== undefined && !isDefaultIssuePriority(input.priority)) {
    return NextResponse.json(
      { error: ISSUE_PRIORITY_SCHEMA_UNAVAILABLE_MESSAGE },
      { status: 409 },
    );
  }
  const nextPosition = typeof input.position === 'number'
    ? input.position
    : nextStatus !== currentStatus
      ? await getNextIssuePosition(existing.projectId, nextStatus)
      : existing.position;
  const shouldEnterDoing = currentStatus !== 'doing' && nextStatus === 'doing';

  let activeTask: Parameters<typeof serializeTaskResponse>[0] | null =
    activeTaskByIssueId.get(existing.id) ?? null;
  let linkedTask: Parameters<typeof serializeTaskResponse>[0] | null =
    linkedTaskByIssueId.get(existing.id) ?? activeTask;
  const shouldRestartLinkedTask = shouldEnterDoing && !activeTask && Boolean(linkedTask);
  const shouldSpawnTask = shouldEnterDoing && !activeTask && !linkedTask;
  const shouldKillActiveTask = currentStatus === 'doing' && nextStatus === 'done' && Boolean(activeTask);
  let killedTask: Parameters<typeof serializeTaskResponse>[0] | null = null;
  let spawnedTask: Awaited<ReturnType<typeof createAiTaskArtifacts>> | null = null;
  let spawnTaskArgs: Parameters<typeof createAiTaskArtifacts>[0] | null = null;
  let restartPlan: PlannedInplaceTaskRestart | null = null;

  if (shouldSpawnTask && !activeTask) {
    const defaultProject = await db.defaultProject.findUnique({
      where: { userId: user.id },
      select: { projectId: true },
    });
    const isDefaultProject = defaultProject?.projectId === existing.projectId;
    const projectDaemonHost = normalizeOptionalString(existing.project.daemonHost);
    const projectWorkspacePath = normalizeOptionalString(existing.project.workspacePath);
    const projectRepoRoot = normalizeOptionalString(existing.project.repoRoot);
    const projectWorktreeBranch = normalizeOptionalString(existing.project.worktreeBranch);
    const projectLastCommit = normalizeOptionalString(existing.project.lastCommit);

    if (
      (!isDefaultProject && (!projectDaemonHost || !projectWorkspacePath)) ||
      (projectDaemonHost && !projectWorkspacePath) ||
      (!projectDaemonHost && projectWorkspacePath)
    ) {
      return NextResponse.json({ error: 'Project binding incomplete' }, { status: 409 });
    }

    const connectedAgents = realtimeHub.getAgentsForUser(user.id) as ConnectedAgent[];
    if (
      projectDaemonHost &&
      !connectedAgents.some((agent) => agent.host === projectDaemonHost)
    ) {
      return NextResponse.json(
        { error: `Project daemon ${projectDaemonHost} is offline` },
        { status: 409 },
      );
    }

    const agentHost = projectDaemonHost ?? pickDefaultAgentHost(connectedAgents, null) ?? null;
    const initialContent = buildIssueInitialContent({
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
    });
    const metadata = initialContent ? { initialContent } : null;
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
      projectId: existing.projectId,
      issueId: existing.id,
      title: input.title ?? existing.title,
      agentHost,
      requestedId: requestedTaskId,
      launchConfig,
      metadata,
      initialMessageContent: initialContent,
    };
  }

  if (shouldRestartLinkedTask && linkedTask) {
    const connectedAgents = realtimeHub.getAgentsForUser(user.id) as ConnectedAgent[];
    const restartPlanResult = planInplaceTaskRestart({
      sourceTask: linkedTask,
      project: existing.project,
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

  const issueUpdateData = {
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

  const serializedIssue = serializeIssueWithTasks(updated, {
    activeTask,
    linkedTask,
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
      project: { userId: user.id },
    },
    select: issueSelect,
  });

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await db.issue.delete({ where: { id: issueId } });
  return new NextResponse(null, { status: 204 });
}
