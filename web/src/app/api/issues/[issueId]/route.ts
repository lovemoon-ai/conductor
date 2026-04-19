import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import {
  createAiTaskArtifacts,
  finalizeAiTaskCreation,
} from '@/lib/tasks/create-ai-task';
import { serializeTaskResponse } from '@/lib/tasks/serialization';
import { normalizeOptionalString, type JsonObject } from '@/lib/tasks/task-config';
import { buildTaskWorktreeLaunchConfig } from '@/lib/tasks/worktree';
import {
  ConnectedAgent,
  pickDefaultAgentHost,
} from '@/lib/tasks/pty-runtime';
import { realtimeHub } from '@/lib/realtime/hub';
import {
  buildIssueInitialContent,
  getNextIssuePosition,
  issuePatchSchema,
  issueWithActiveTaskInclude,
  normalizeIssuePatchBody,
  serializeIssueWithActiveTask,
} from '../shared';

const issueSelect = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  position: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
};

const issueWithProjectAndActiveTaskInclude = {
  ...issueWithActiveTaskInclude,
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ issueId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { issueId } = await params;
  const issue = await db.issue.findFirst({
    where: {
      id: issueId,
      project: { userId: user.id },
    },
    include: issueWithActiveTaskInclude,
  });

  if (!issue) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(serializeIssueWithActiveTask(issue));
}

export async function PATCH(
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
    include: issueWithProjectAndActiveTaskInclude,
  });

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = issuePatchSchema.safeParse(normalizeIssuePatchBody(body));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const nextStatus = input.status ?? existing.status;
  const nextPosition = typeof input.position === 'number'
    ? input.position
    : nextStatus !== existing.status
      ? await getNextIssuePosition(existing.projectId, nextStatus)
      : existing.position;
  const shouldSpawnTask = existing.status === 'todo' && nextStatus === 'doing';

  let activeTask: Parameters<typeof serializeTaskResponse>[0] | null = existing.tasks[0] ?? null;
  let spawnedTask: Awaited<ReturnType<typeof createAiTaskArtifacts>> | null = null;
  let spawnTaskArgs: Parameters<typeof createAiTaskArtifacts>[0] | null = null;

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

  const issueUpdateArgs = {
    where: { id: existing.id },
    data: {
      title: input.title ?? existing.title,
      description: input.description !== undefined ? input.description : existing.description,
      status: nextStatus,
      position: nextPosition,
      metadata: input.metadata !== undefined
        ? (input.metadata ? JSON.stringify(input.metadata) : null)
        : existing.metadata,
    },
    include: issueWithActiveTaskInclude,
  };

  let updated;
  if (spawnTaskArgs) {
    const transactionResult = await db.$transaction(async (tx) => {
      // Atomically claim the todo -> doing transition.
      // updateMany returns count; if 0, another request already transitioned this issue.
      const claimed = await tx.issue.updateMany({
        where: {
          id: existing.id,
          status: 'todo',
        },
        data: {
          status: 'doing',
        },
      });

      if (claimed.count === 0) {
        // Another concurrent request already claimed the transition — just update remaining fields
        const updatedIssue = await tx.issue.update(issueUpdateArgs);
        return {
          createdTask: null,
          updatedIssue,
          skippedSpawn: true,
        };
      }

      // We own the transition — safe to spawn the task
      const createdTask = await createAiTaskArtifacts(spawnTaskArgs!, tx);
      const updatedIssue = await tx.issue.update(issueUpdateArgs);
      return {
        createdTask,
        updatedIssue,
        skippedSpawn: false,
      };
    });

    if (!transactionResult.skippedSpawn && transactionResult.createdTask) {
      spawnedTask = transactionResult.createdTask;
      activeTask = transactionResult.createdTask.task;

      await finalizeAiTaskCreation({
        ...spawnTaskArgs,
        ...transactionResult.createdTask,
      });
    }
    updated = transactionResult.updatedIssue;
  } else {
    updated = await db.issue.update(issueUpdateArgs);
  }

  const serializedIssue = serializeIssueWithActiveTask(updated);
  const serializedActiveTask = activeTask ? serializeTaskResponse(activeTask) : null;
  const serializedSpawnedTask = spawnedTask ? serializeTaskResponse(spawnedTask.task) : null;

  return NextResponse.json({
    issue: serializedIssue,
    activeTask: serializedActiveTask,
    active_task: serializedActiveTask,
    spawnedTask: serializedSpawnedTask,
    spawned_task: serializedSpawnedTask,
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
