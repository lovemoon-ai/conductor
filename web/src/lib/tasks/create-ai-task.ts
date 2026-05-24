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

export type AiTaskGoalDescriptor = {
  objective: string;
  source: 'issue' | 'manual';
  issueId?: string | null;
};

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
  /**
   * When set to `"goal"`, the daemon spawns fire with `--goal` so the
   * `initialMessageContent` is interpreted as the goal objective. Stamped onto
   * `launchConfig.aiMode` + `metadata.aiMode`, and the initial message gets
   * `metadata.goal = true` so the timeline can label the bubble. Goal mode is
   * gated to goal-capable backends by the caller — this helper just persists
   * what it is given.
   */
  aiMode?: 'goal' | null;
  goal?: AiTaskGoalDescriptor | null;
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
  /**
   * The launchConfig with `aiMode` + `goal` already merged in, computed once
   * in `createAiTaskArtifacts` so `finalizeAiTaskCreation` can reuse it
   * verbatim. Previously both helpers each recomputed via
   * `applyGoalToLaunchConfig` on `args.launchConfig`, opening a divergence
   * window if the inputs ever drifted between calls. Single source of truth.
   */
  effectiveLaunchConfig: JsonObject | null;
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

/**
 * Merge `aiMode` + `goal` (when present) into the launchConfig persisted on
 * the task and shipped to the daemon, without dropping anything the caller
 * already put in launchConfig (e.g. worktree fields).
 */
const applyGoalToLaunchConfig = (
  launchConfig: JsonObject | null,
  aiMode: 'goal' | null | undefined,
  goal: AiTaskGoalDescriptor | null | undefined,
): JsonObject | null => {
  if (!aiMode && !goal) {
    return launchConfig;
  }
  const base: JsonObject = launchConfig ? { ...launchConfig } : {};
  if (aiMode) {
    base.aiMode = aiMode;
  }
  if (goal) {
    base.goal = {
      objective: goal.objective,
      source: goal.source,
      ...(goal.issueId ? { issueId: goal.issueId } : {}),
    };
  }
  return base;
};

/**
 * Mirror goal state onto the task's `metadata` JSON column so UI surfaces
 * (board / issue detail) can render "Goal" badges without re-parsing
 * launchConfig.
 *
 * The caller is responsible for gating goal-mode dispatch to goal-capable
 * backends (see `isGoalCapableBackend` in `web/src/app/api/issues/goal.ts`
 * and `GOAL_CAPABLE_BACKENDS` in `cli/bin/conductor-fire.js`). This helper
 * trusts the caller on that front.
 *
 * Defensive guard (N6): if `aiMode === 'goal'` arrives without a
 * `goal.objective`, we treat it as a no-op and DON'T stamp `metadata.aiMode`.
 * This catches "caller forgot to set goal but set aiMode" bugs where the UI
 * would otherwise render a phantom Goal badge for a task that has no goal.
 */
const applyGoalToMetadata = (
  metadata: JsonObject | null | undefined,
  aiMode: 'goal' | null | undefined,
  goal: AiTaskGoalDescriptor | null | undefined,
): JsonObject | null => {
  if (!aiMode && !goal) {
    return metadata ?? null;
  }
  // Defensive: aiMode='goal' without a valid objective is a caller bug — skip
  // the stamp rather than producing a metadata.aiMode that lies about reality.
  const objective = typeof goal?.objective === 'string' ? goal.objective.trim() : '';
  const effectiveAiMode = aiMode === 'goal' && !objective ? null : aiMode;
  if (!effectiveAiMode && !goal) {
    return metadata ?? null;
  }
  const base: JsonObject = metadata ? { ...metadata } : {};
  if (effectiveAiMode) {
    base.aiMode = effectiveAiMode;
  }
  if (goal && objective) {
    base.goal = {
      source: goal.source,
      status: 'created',
      ...(goal.issueId ? { issueId: goal.issueId } : {}),
    };
  }
  return base;
};

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
  const effectiveLaunchConfig = applyGoalToLaunchConfig(
    args.launchConfig ?? null,
    args.aiMode ?? null,
    args.goal ?? null,
  );
  const effectiveMetadata = applyGoalToMetadata(
    args.metadata ?? null,
    args.aiMode ?? null,
    args.goal ?? null,
  );

  const task = await createAiTaskRecord(dbClient.task, {
    ...args,
    launchConfig: effectiveLaunchConfig,
    metadata: effectiveMetadata,
    status: resolveDefaultAiTaskStatus(args),
  });

  const initialMessageContent = normalizeInitialMessageContent(args.initialMessageContent);

  let initialMessage: CreatedAiTaskMessage | null = null;
  if (initialMessageContent) {
    const messageMetadata = args.aiMode === 'goal' ? { goal: true } : null;
    initialMessage = await dbClient.message.create({
      data: {
        taskId: task.id,
        role: 'user',
        content: initialMessageContent,
        ...(messageMetadata ? { metadata: JSON.stringify(messageMetadata) } : {}),
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
    effectiveLaunchConfig,
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
  // Reuse the launchConfig computed by `createAiTaskArtifacts` (which already
  // merged `aiMode` + `goal`). Recomputing here would create a second source
  // of truth that could drift from what was persisted to the task row. The
  // CLI agent reads `launch_config.aiMode` here to decide whether to append
  // `--goal` to fire's spawn args.
  const dispatchLaunchConfig = args.effectiveLaunchConfig
    ?? applyGoalToLaunchConfig(
      args.launchConfig ?? null,
      args.aiMode ?? null,
      args.goal ?? null,
    );
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
          launch_config: dispatchLaunchConfig ?? undefined,
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
