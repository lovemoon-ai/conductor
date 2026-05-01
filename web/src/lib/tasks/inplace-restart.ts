import { randomUUID } from 'crypto';
import { deliverAgentOutboxForHost } from '@/lib/realtime/agent-outbox';
import { realtimeHub } from '@/lib/realtime/hub';
import { canInplaceRestart } from '@/lib/tasks/restart';
import {
  normalizeOptionalString,
  normalizeTaskStatus,
  parseJsonObject,
  type JsonObject,
} from '@/lib/tasks/task-config';
import {
  acquireTaskWorktreeMutationLock,
  inheritTaskWorktreeLaunchConfig,
} from '@/lib/tasks/worktree';
import { normalizeBackendType } from '@/lib/tasks/pty-runtime';
import { isConductorFireHost } from '@/lib/subscription/plan-limits';
import { persistIssueAiSession } from '@/lib/issues/persist-ai-session';

type RestartableTask = {
  id: string;
  projectId: string;
  issueId?: string | null;
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

type RestartProjectBinding = {
  daemonHost?: string | null;
};

type RestartAgent = {
  host: string;
  supportedBackends?: string[];
};

export type PlannedInplaceTaskRestart = {
  restartAgentHost: string;
  sourceBackend: string;
  sourceSessionId: string;
  inheritedWorktreeLaunchConfig: JsonObject | null;
};

type InplaceRestartPlanResult =
  | {
      ok: true;
      plan: PlannedInplaceTaskRestart;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

export const planInplaceTaskRestart = (args: {
  sourceTask: RestartableTask;
  project: RestartProjectBinding;
  connectedAgents: RestartAgent[];
}): InplaceRestartPlanResult => {
  const sourceTaskType = normalizeOptionalString(args.sourceTask.taskType) ?? 'ai_task';
  if (sourceTaskType !== 'ai_task') {
    return { ok: false, error: 'Only ai_task supports restart', status: 409 };
  }

  const sourceBackend = normalizeBackendType(args.sourceTask.backendType);
  if (!sourceBackend) {
    return { ok: false, error: 'Task missing backend binding', status: 409 };
  }

  const sourceSessionId = normalizeOptionalString(args.sourceTask.sessionId);
  if (!sourceSessionId) {
    return { ok: false, error: 'Task missing session binding', status: 409 };
  }

  const sourceStatus = normalizeTaskStatus(args.sourceTask.status);
  if (!canInplaceRestart(sourceStatus, sourceBackend, sourceBackend)) {
    return {
      ok: false,
      error: 'In-place restart requires a stopped task on the current backend',
      status: 409,
    };
  }

  const sourceAgentHost = normalizeOptionalString(args.sourceTask.agentHost);
  if (!sourceAgentHost) {
    return { ok: false, error: 'Task missing source daemon binding', status: 409 };
  }

  const projectDaemonHost = normalizeOptionalString(args.project.daemonHost);
  const sourceTaskMetadata = parseJsonObject(args.sourceTask.metadata);
  const sourceMetadataDaemonHost = normalizeOptionalString(sourceTaskMetadata?.daemonName);
  const sourceExecutionHost = normalizeOptionalString(args.sourceTask.executionHost);
  const isManualFireTask = isConductorFireHost(sourceAgentHost);
  const manualFireDaemonHostCandidates: string[] = [];

  for (const candidate of [
    sourceMetadataDaemonHost && !isConductorFireHost(sourceMetadataDaemonHost)
      ? sourceMetadataDaemonHost
      : null,
    sourceExecutionHost && !isConductorFireHost(sourceExecutionHost)
      ? sourceExecutionHost
      : null,
    projectDaemonHost && !isConductorFireHost(projectDaemonHost)
      ? projectDaemonHost
      : null,
  ]) {
    if (candidate && !manualFireDaemonHostCandidates.includes(candidate)) {
      manualFireDaemonHostCandidates.push(candidate);
    }
  }

  let restartAgentHost = isManualFireTask
    ? manualFireDaemonHostCandidates.find((host) =>
        args.connectedAgents.some((agent) => agent.host === host),
      ) ?? manualFireDaemonHostCandidates[0] ?? null
    : sourceAgentHost;

  if (projectDaemonHost) {
    if (
      sourceAgentHost &&
      !isConductorFireHost(sourceAgentHost) &&
      sourceAgentHost !== projectDaemonHost
    ) {
      return {
        ok: false,
        error: `Task daemon ${sourceAgentHost} does not match project binding ${projectDaemonHost}`,
        status: 409,
      };
    }
    restartAgentHost = projectDaemonHost;
  }

  if (!restartAgentHost) {
    return {
      ok: false,
      error: isManualFireTask
        ? 'Task missing original daemon binding'
        : `No compatible daemon online for backend ${sourceBackend}`,
      status: 409,
    };
  }

  const restartAgent = args.connectedAgents.find((agent) => agent.host === restartAgentHost) ?? null;
  if (!restartAgent) {
    return {
      ok: false,
      error: projectDaemonHost
        ? `Project daemon ${restartAgentHost} is offline`
        : isManualFireTask
          ? `Original daemon ${restartAgentHost} is offline`
          : `Source daemon ${sourceAgentHost} is offline`,
      status: 409,
    };
  }

  const supportedBackends = Array.isArray(restartAgent.supportedBackends)
    ? restartAgent.supportedBackends
    : [];
  if (!supportedBackends.includes(sourceBackend)) {
    return {
      ok: false,
      error: `Daemon ${restartAgentHost} does not support backend ${sourceBackend}`,
      status: 409,
    };
  }

  return {
    ok: true,
    plan: {
      restartAgentHost,
      sourceBackend,
      sourceSessionId,
      inheritedWorktreeLaunchConfig: inheritTaskWorktreeLaunchConfig(
        parseJsonObject(args.sourceTask.launchConfig),
      ),
    },
  };
};

export const restartTaskInPlace = async (args: {
  tx: {
    task: {
      update: (value: Record<string, unknown>) => Promise<RestartableTask>;
    };
    agentOutbox: {
      create: (value: Record<string, unknown>) => Promise<unknown>;
    };
    issue: {
      update: (value: Record<string, unknown>) => Promise<unknown>;
    };
  };
  userId: string;
  sourceTask: RestartableTask;
  plan: PlannedInplaceTaskRestart;
  now?: Date;
  requestId?: string;
}) => {
  const requestId = args.requestId ?? randomUUID();
  const now = args.now ?? new Date();

  if (args.plan.inheritedWorktreeLaunchConfig) {
    await acquireTaskWorktreeMutationLock(args.tx as any, args.sourceTask.id);
  }

  await args.tx.agentOutbox.create({
    data: {
      userId: args.userId,
      agentHost: args.plan.restartAgentHost,
      taskId: args.sourceTask.id,
      eventType: 'restart_task',
      requestId,
      payloadJson: JSON.stringify({
        type: 'restart_task',
        payload: {
          mode: 'resume_inplace',
          source_task_id: args.sourceTask.id,
          target_task_id: args.sourceTask.id,
          project_id: args.sourceTask.projectId,
          title: args.sourceTask.title,
          source_backend_type: args.plan.sourceBackend,
          source_session_id: args.plan.sourceSessionId,
          source_session_file_path: args.sourceTask.sessionFilePath ?? undefined,
          target_backend_type: args.plan.sourceBackend,
          target_launch_config: args.plan.inheritedWorktreeLaunchConfig ?? undefined,
          request_id: requestId,
        },
      }),
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: null,
    },
  });

  const task = await args.tx.task.update({
    where: { id: args.sourceTask.id },
    data: {
      status: 'running',
      executionHost: args.plan.restartAgentHost,
      agentHost: args.plan.restartAgentHost,
      updatedAt: now,
    },
  });

  // Restart preserves the source backend/session pair — make sure the linked
  // issue mirrors them so the breadcrumb is intact even for tasks that were
  // created before the persistIssueAiSession behavior shipped. Runs inside the
  // same transaction so a rollback also discards the issue update.
  if (args.sourceTask.issueId) {
    await persistIssueAiSession(
      { issue: args.tx.issue },
      args.sourceTask.issueId,
      {
        backendType: args.plan.sourceBackend,
        sessionId: args.plan.sourceSessionId,
      },
    );
  }

  return {
    requestId,
    restartAgentHost: args.plan.restartAgentHost,
    task,
  };
};

export const finalizeInplaceTaskRestart = async (args: {
  userId: string;
  taskId: string;
  restartAgentHost: string;
}) => {
  realtimeHub.bindTaskToAgent(args.taskId, args.restartAgentHost);
  await deliverAgentOutboxForHost({
    userId: args.userId,
    agentHost: args.restartAgentHost,
    sendToAgentHost: ({ userId, agentHost, envelope }) =>
      realtimeHub.sendToAgentHost(userId, agentHost, envelope),
    resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
  }).catch(() => {});
};
