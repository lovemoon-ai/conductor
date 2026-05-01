import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime/hub';
import { enqueueAndAttemptAgentCommand } from '@/lib/realtime/agent-outbox';
import { persistIssueAiSession } from '@/lib/issues/persist-ai-session';
import {
  applyLegacyTaskShape,
  isMissingIssueIdSchemaError,
  isMissingPtySchemaError,
  legacyTaskSelect,
  taskSelectWithoutIssueId,
} from '@/lib/tasks/pty-compat';
import {
  normalizeTaskStatus,
  serializeJsonObject,
  type JsonObject,
} from '@/lib/tasks/task-config';
import { isConductorFireHost } from '@/lib/subscription/plan-limits';

type CreateAiTaskArgs = {
  userId: string;
  projectId: string;
  issueId?: string | null;
  title: string;
  agentHost: string | null;
  requestedId?: string;
  requestedBackendType?: string | null;
  requestedSessionId?: string | null;
  requestedSessionFilePath?: string | null;
  launchConfig?: JsonObject | null;
  metadata?: JsonObject | null;
  initialMessageContent?: string | null;
  status?: string | null;
};

type CreatedAiTask = {
  id: string;
  projectId: string;
  issueId: string | null;
  title: string;
  taskType?: string | null;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  backendType: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  launchConfig?: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type CreatedAiTaskMessage = {
  id: string;
  createdAt: Date;
};

type AiTaskDbClient = {
  task: Pick<typeof db.task, 'create' | 'update'>;
  message: Pick<typeof db.message, 'create'>;
  issue: Pick<typeof db.issue, 'update'>;
};

type CreatedAiTaskArtifacts = {
  task: CreatedAiTask;
  initialMessage: CreatedAiTaskMessage | null;
  initialMessageContent: string | null;
};

const resolveDefaultAiTaskStatus = (args: Pick<CreateAiTaskArgs, 'status' | 'agentHost'>): string =>
  args.status ??
  (typeof args.agentHost === 'string' && isConductorFireHost(args.agentHost)
    ? 'running'
    : 'init');

const normalizeInitialMessageContent = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : null;

const createAiTaskRecord = async (
  taskStore: AiTaskDbClient['task'],
  args: CreateAiTaskArgs,
): Promise<CreatedAiTask> => {
  try {
    return await taskStore.create({
      data: {
        id: args.requestedId,
        projectId: args.projectId,
        issueId: args.issueId ?? null,
        title: args.title,
        taskType: 'ai_task',
        status: normalizeTaskStatus(args.status),
        agentHost: args.agentHost,
        executionHost: args.agentHost ?? null,
        backendType: args.requestedBackendType ?? null,
        sessionId: args.requestedSessionId ?? null,
        sessionFilePath: args.requestedSessionFilePath ?? null,
        launchConfig: serializeJsonObject(args.launchConfig ?? null),
        metadata: args.metadata ? JSON.stringify(args.metadata) : null,
      },
    });
  } catch (error) {
    // Tier 1 fallback: only issue_id column is missing — keep PTY fields intact
    if (isMissingIssueIdSchemaError(error)) {
      const created = await taskStore.create({
        data: {
          id: args.requestedId,
          projectId: args.projectId,
          title: args.title,
          taskType: 'ai_task',
          status: normalizeTaskStatus(args.status),
          agentHost: args.agentHost,
          executionHost: args.agentHost ?? null,
          backendType: args.requestedBackendType ?? null,
          sessionId: args.requestedSessionId ?? null,
          sessionFilePath: args.requestedSessionFilePath ?? null,
          launchConfig: serializeJsonObject(args.launchConfig ?? null),
          metadata: args.metadata ? JSON.stringify(args.metadata) : null,
        },
        select: taskSelectWithoutIssueId,
      });
      return { ...created, issueId: null };
    }
    // Tier 2 fallback: genuinely missing PTY schema columns
    if (!isMissingPtySchemaError(error)) {
      throw error;
    }
    const legacyTask = await taskStore.create({
      data: {
        id: args.requestedId,
        projectId: args.projectId,
        title: args.title,
        status: normalizeTaskStatus(args.status),
        agentHost: args.agentHost,
        executionHost: args.agentHost ?? null,
        backendType: args.requestedBackendType ?? null,
        sessionId: args.requestedSessionId ?? null,
        sessionFilePath: args.requestedSessionFilePath ?? null,
        metadata: args.metadata ? JSON.stringify(args.metadata) : null,
      },
      select: legacyTaskSelect,
    });
    return { ...applyLegacyTaskShape(legacyTask), issueId: null };
  }
};

const touchTaskUpdatedAt = async (
  taskStore: AiTaskDbClient['task'],
  taskId: string,
  updatedAt: Date,
): Promise<Date> => {
  try {
    const task = await taskStore.update({
      where: { id: taskId },
      data: { updatedAt },
    });
    return task.updatedAt instanceof Date ? task.updatedAt : updatedAt;
  } catch (error) {
    if (!isMissingPtySchemaError(error) && !isMissingIssueIdSchemaError(error)) {
      throw error;
    }

    const task = await taskStore.update({
      where: { id: taskId },
      data: { updatedAt },
      select: {
        updatedAt: true,
      },
    });
    return task.updatedAt instanceof Date ? task.updatedAt : updatedAt;
  }
};

export async function createAiTaskArtifacts(
  args: CreateAiTaskArgs,
  dbClient: AiTaskDbClient = db,
): Promise<CreatedAiTaskArtifacts> {
  const task = await createAiTaskRecord(dbClient.task, {
    ...args,
    status: resolveDefaultAiTaskStatus(args),
  });

  const initialMessageContent = normalizeInitialMessageContent(args.initialMessageContent);

  let initialMessage: CreatedAiTaskMessage | null = null;
  if (initialMessageContent) {
    initialMessage = await dbClient.message.create({
      data: {
        taskId: task.id,
        role: 'user',
        content: initialMessageContent,
      },
      select: {
        id: true,
        createdAt: true,
      },
    });

    task.updatedAt = await touchTaskUpdatedAt(dbClient.task, task.id, new Date());
  }

  // Mirror AI session breadcrumbs onto the issue so the trail survives task
  // deletion. Stays inside the same transaction (dbClient) so a rollback also
  // discards the issue update. Only persists when issueId is set and at least
  // one of the backend type / session id has a non-empty value.
  if (task.issueId && (task.backendType || task.sessionId)) {
    await persistIssueAiSession(
      { issue: dbClient.issue },
      task.issueId,
      {
        backendType: task.backendType,
        sessionId: task.sessionId,
      },
    );
  }

  return {
    task,
    initialMessage,
    initialMessageContent,
  };
}

export async function finalizeAiTaskCreation(
  args: CreateAiTaskArgs & CreatedAiTaskArtifacts,
): Promise<void> {
  if (args.initialMessage && args.initialMessageContent) {
    realtimeHub.broadcast(args.userId, args.task.projectId, {
      type: 'task_user_message',
      payload: {
        id: args.initialMessage.id,
        task_id: args.task.id,
        project_id: args.task.projectId,
        role: 'user',
        content: args.initialMessageContent,
        created_at: args.initialMessage.createdAt.toISOString(),
      },
    });
  }

  if (!args.agentHost) {
    return;
  }

  realtimeHub.bindTaskToAgent(args.task.id, args.agentHost);
  if (isConductorFireHost(args.agentHost)) {
    return;
  }

  const requestId = randomUUID();
  await enqueueAndAttemptAgentCommand(
    {
      userId: args.userId,
      agentHost: args.agentHost,
      taskId: args.task.id,
      eventType: 'create_task',
      requestId,
      envelope: {
        type: 'create_task',
        payload: {
          task_id: args.task.id,
          project_id: args.task.projectId,
          title: args.task.title,
          backend_type: args.task.backendType ?? args.metadata?.backendType,
          initial_content: args.initialMessageContent ?? undefined,
          launch_config: args.launchConfig ?? undefined,
          request_id: requestId,
        },
      },
    },
    {
      agentHost: args.agentHost,
      sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
        realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
      resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
    },
  );
}

export async function createAndDispatchAiTask(args: CreateAiTaskArgs): Promise<CreatedAiTask> {
  const result = await db.$transaction(async (tx) => createAiTaskArtifacts(args, tx));

  await finalizeAiTaskCreation({
    ...args,
    ...result,
  });

  return result.task;
}
