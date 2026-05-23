import { randomBytes, randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { ensureDefaultProject } from '@/lib/auth/service';
import { enqueueAndAttemptAgentCommand } from '@/lib/realtime/agent-outbox';
import { realtimeHub } from '@/lib/realtime/hub';
import { isConductorFireHost } from '@/lib/subscription/plan-limits';
import { appendUserMessageToTask, createTaskForUser } from '@/lib/channel/task-ingress-service';
import {
  buildKilledPatch,
  withKilledReasonFallback,
} from '@/lib/tasks/killed-reason';
import { getFeishuProviderConfigForUser } from './provider-config';
import type { NormalizedInboundEvent, NormalizedOutboundMessage } from './types';

const BIND_CODE_TYPE = 'CHANNEL_BIND';
const BIND_CODE_EXPIRES_IN_SECONDS = 600;
const DEFAULT_TASK_LIST_LIMIT = 10;

type InboundResult = {
  outputs: Array<{ text: string }>;
  duplicate?: boolean;
};

const makeCode = (): string => randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6);

type ConnectedDaemon = {
  id: string;
  host: string;
  supportedBackends: string[];
};

function buildConversationKey(event: NormalizedInboundEvent): { provider: string; externalChatId: string; externalThreadId: string } {
  return {
    provider: event.provider,
    externalChatId: event.externalChatId,
    externalThreadId: event.externalThreadId ?? event.externalTopicId ?? '',
  };
}

async function getDefaultProjectId(userId: string): Promise<string> {
  const project = await ensureDefaultProject(userId);
  return project.id;
}

async function getExternalAccount(event: NormalizedInboundEvent) {
  return (db as any).externalAccount.findFirst({
    where: {
      provider: event.provider,
      externalUserId: event.externalUserId,
    },
  });
}

async function upsertConversation(input: {
  provider: string;
  externalChatId: string;
  externalThreadId?: string | null;
  externalRootMessageId?: string | null;
  userId: string;
  projectId: string;
  taskId?: string | null;
  boundDaemonName?: string | null;
}) {
  const where = {
    provider_externalChatId_externalThreadId: {
      provider: input.provider,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId ?? '',
    },
  } as any;

  return (db as any).channelConversation.upsert({
    where,
    update: {
      userId: input.userId,
      projectId: input.projectId,
      taskId: input.taskId ?? undefined,
      boundDaemonName: input.boundDaemonName ?? undefined,
      externalRootMessageId: input.externalRootMessageId ?? undefined,
      status: 'ACTIVE',
    },
    create: {
      provider: input.provider,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId ?? '',
      externalRootMessageId: input.externalRootMessageId ?? null,
      userId: input.userId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      boundDaemonName: input.boundDaemonName ?? null,
      status: 'ACTIVE',
    },
  });
}

export async function issueBindCode(userId: string): Promise<{ code: string; expiresIn: number }> {
  const code = makeCode();
  const expiresAt = new Date(Date.now() + BIND_CODE_EXPIRES_IN_SECONDS * 1000);
  await db.verification.create({
    data: {
      userId,
      target: `channel:${userId}`,
      code,
      type: BIND_CODE_TYPE,
      expiresAt,
      verified: false,
    },
  });
  return { code, expiresIn: BIND_CODE_EXPIRES_IN_SECONDS };
}

export async function enqueueChannelMessage(input: NormalizedOutboundMessage): Promise<void> {
  await (db as any).channelOutbox.create({
    data: {
      provider: input.provider,
      userId: input.userId,
      conversationId: input.conversationId,
      taskId: input.taskId ?? null,
      targetChatId: input.targetChatId,
      targetReplyMessageId: input.targetReplyMessageId ?? null,
      targetThreadId: input.targetThreadId ?? null,
      targetTopicId: input.targetTopicId ?? null,
      eventType: input.kind,
      dedupeKey: input.dedupeKey,
      payloadJson: JSON.stringify({ text: input.text, metadata: input.metadata ?? null }),
      status: 'pending',
      attemptCount: 0,
    },
  });
}

async function consumeBindCode(code: string): Promise<{ userId: string } | null> {
  const record = await db.verification.findFirst({
    where: {
      code,
      type: BIND_CODE_TYPE,
      verified: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!record?.userId) return null;
  await db.verification.update({ where: { id: record.id }, data: { verified: true } });
  return { userId: record.userId };
}

function renderTaskList(tasks: Array<{ id: string; title: string; status: string; updatedAt: Date }>): string {
  if (tasks.length === 0) return 'No tasks found.';
  return tasks
    .map((task) => `- ${task.title} [${task.status}] (${task.id}) ${task.updatedAt.toISOString()}`)
    .join('\n');
}

async function handleBind(event: NormalizedInboundEvent, code: string): Promise<InboundResult> {
  const consumed = await consumeBindCode(code);
  if (!consumed) {
    return { outputs: [{ text: 'Bind code invalid or expired.' }] };
  }
  const projectId = await getDefaultProjectId(consumed.userId);
  await (db as any).externalAccount.upsert({
    where: {
      provider_externalUserId: {
        provider: event.provider,
        externalUserId: event.externalUserId,
      },
    },
    update: {
      userId: consumed.userId,
      tenantKey: event.externalTenantId ?? undefined,
    },
    create: {
      userId: consumed.userId,
      provider: event.provider,
      externalUserId: event.externalUserId,
      tenantKey: event.externalTenantId ?? null,
    },
  });
  await upsertConversation({
    provider: event.provider,
    externalChatId: event.externalChatId,
    externalThreadId: event.externalThreadId,
    externalRootMessageId: event.externalRootMessageId,
    userId: consumed.userId,
    projectId,
    taskId: null,
  });
  return { outputs: [{ text: 'Your Feishu account is now bound to Conductor.' }] };
}

async function requireBoundAccount(event: NormalizedInboundEvent) {
  const account = await getExternalAccount(event);
  if (!account) return null;
  const projectId = await getDefaultProjectId(account.userId);
  const providerConfig = event.provider === 'FEISHU'
    ? await getFeishuProviderConfigForUser(account.userId)
    : null;
  const conversation = await upsertConversation({
    provider: event.provider,
    externalChatId: event.externalChatId,
    externalThreadId: event.externalThreadId,
    externalRootMessageId: event.externalRootMessageId,
    userId: account.userId,
    projectId,
    boundDaemonName: providerConfig?.defaultDaemonName ?? undefined,
  });
  return { account, projectId, conversation, providerConfig };
}

function getConnectedDaemons(userId: string): ConnectedDaemon[] {
  return (realtimeHub.getAgentsForUser(userId) as ConnectedDaemon[])
    .filter((agent) => agent.host && !isConductorFireHost(agent.host));
}

function pickDaemonBackend(daemon: ConnectedDaemon | null): string | null {
  if (!daemon) return null;
  return daemon.supportedBackends.find((backend) => typeof backend === 'string' && backend.trim()) ?? null;
}

function renderDaemonList(currentDaemonName: string | null, daemons: ConnectedDaemon[]): string {
  if (daemons.length === 0) {
    return currentDaemonName
      ? `No daemons are online.\ncurrent: ${currentDaemonName}`
      : 'No daemons are online.';
  }

  const lines = ['Available daemons:'];
  for (const daemon of daemons) {
    const currentLabel = daemon.host === currentDaemonName ? ' (current)' : '';
    const backends = daemon.supportedBackends.length > 0 ? ` [${daemon.supportedBackends.join(', ')}]` : '';
    lines.push(`- ${daemon.host}${currentLabel}${backends}`);
  }
  return lines.join('\n');
}

function renderTaskCreatedMessage(task: {
  id: string;
  agentHost?: string | null;
  backendType?: string | null;
  sessionId?: string | null;
}): string {
  return [
    `Task ${task.id} created.`,
    `daemon: ${task.agentHost ?? 'n/a'}`,
    `backend: ${task.backendType ?? 'default'}`,
    `session_id: ${task.sessionId ?? 'pending'}`,
  ].join('\n');
}

async function createConversationTask(input: {
  userId: string;
  projectId: string;
  conversationId: string;
  boundDaemonName: string | null;
  daemons: ConnectedDaemon[];
  initialContent?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<InboundResult> {
  const daemon = input.boundDaemonName
    ? input.daemons.find((candidate) => candidate.host === input.boundDaemonName) ?? null
    : null;

  if (!daemon) {
    return {
      outputs: [{
        text: 'Task creation failed: no available daemon. Use /daemons and /use-daemon <name>.',
      }],
    };
  }

  const created = await createTaskForUser({
    userId: input.userId,
    projectId: input.projectId,
    agentHost: daemon.host,
    backendType: pickDaemonBackend(daemon),
    initialContent: input.initialContent ?? null,
    metadata: input.metadata ?? null,
  });
  await (db as any).channelConversation.update({
    where: { id: input.conversationId },
    data: { taskId: created.task.id },
  });

  return { outputs: [{ text: renderTaskCreatedMessage(created.task) }] };
}

async function handleTaskSwitch(userId: string, conversationId: string, taskId: string): Promise<string> {
  const task = await db.task.findFirst({
    where: {
      id: taskId,
      project: { userId },
    },
    select: { id: true },
  });
  if (!task) {
    return 'Task not found or not accessible.';
  }

  await (db as any).channelConversation.update({ where: { id: conversationId }, data: { taskId } });
  const messages = await db.message.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, take: 10 });
  const history = messages.slice().reverse().map((message) => `${message.role}: ${message.content}`).join('\n');
  return [`Attached to ${taskId}.`, history].filter(Boolean).join('\n');
}

async function handleCommand(context: Awaited<ReturnType<typeof requireBoundAccount>>, event: NormalizedInboundEvent, text: string): Promise<InboundResult> {
  const normalized = text.trim();
  const boundDaemonName = context!.conversation.boundDaemonName ?? context!.providerConfig?.defaultDaemonName ?? null;
  const daemons = getConnectedDaemons(context!.account.userId);

  if (normalized === '/new') {
    return createConversationTask({
      userId: context!.account.userId,
      projectId: context!.projectId,
      conversationId: context!.conversation.id,
      boundDaemonName,
      daemons,
    });
  }

  if (normalized.startsWith('/task ')) {
    const taskId = normalized.slice(6).trim();
    return { outputs: [{ text: await handleTaskSwitch(context!.account.userId, context!.conversation.id, taskId) }] };
  }

  if (normalized === '/tasks' || normalized === '/tasks active' || normalized === '/tasks recent') {
    const where: any = { projectId: context!.projectId };
    if (normalized === '/tasks active') {
      where.status = { in: ['running', 'unknown', 'pending'] };
    }
    const tasks = await db.task.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: DEFAULT_TASK_LIST_LIMIT,
    });
    return { outputs: [{ text: renderTaskList(tasks as any) }] };
  }

  if (normalized === '/daemons') {
    return { outputs: [{ text: renderDaemonList(boundDaemonName, daemons) }] };
  }

  if (normalized.startsWith('/use-daemon ')) {
    const requestedDaemonName = normalized.slice('/use-daemon '.length).trim();
    const matchedDaemon = daemons.find((daemon) => daemon.host === requestedDaemonName);
    if (!matchedDaemon) {
      return { outputs: [{ text: `Daemon ${requestedDaemonName} is not online. Use /daemons to inspect available daemons.` }] };
    }

    await (db as any).channelConversation.update({
      where: { id: context!.conversation.id },
      data: { boundDaemonName: requestedDaemonName },
    });
    return { outputs: [{ text: `Now using daemon ${requestedDaemonName}.` }] };
  }

  if (normalized === '/stop') {
    if (!context!.conversation.taskId) {
      return { outputs: [{ text: 'No active task attached to this conversation.' }] };
    }
    // RFC 0029: explicit user-driven stop from a channel command — tag the
    // killed_reason so the next restart will spawn a fresh fire instead of
    // attempting to reclaim the one the user just asked to stop.
    await withKilledReasonFallback(
      () =>
        db.task.update({
          where: { id: context!.conversation.taskId },
          data: buildKilledPatch('user_stopped'),
        }),
      () =>
        db.task.update({
          where: { id: context!.conversation.taskId },
          data: { status: 'killed' },
        }),
    );
    await enqueueAndAttemptAgentCommand(
      {
        userId: context!.account.userId,
        agentHost: null,
        taskId: context!.conversation.taskId,
        eventType: 'stop_task',
        requestId: randomUUID(),
        envelope: {
          type: 'stop_task',
          payload: { task_id: context!.conversation.taskId, project_id: context!.projectId, reason: 'stopped_from_channel' },
        },
      },
      { sendToAgentHost: () => false },
    );
    return { outputs: [{ text: `Stop requested for ${context!.conversation.taskId}.` }] };
  }

  return { outputs: [{ text: 'Unknown command.' }] };
}

export async function handleNormalizedInboundEvent(event: NormalizedInboundEvent): Promise<InboundResult> {
  const existingInbox = await (db as any).channelInbox.findFirst({
    where: { provider: event.provider, externalMessageId: event.externalMessageId },
  });
  if (existingInbox) {
    return { outputs: [], duplicate: true };
  }

  const contextKey = buildConversationKey(event);
  const existingConversation = await (db as any).channelConversation.findFirst({ where: contextKey });
  await (db as any).channelInbox.create({
    data: {
      provider: event.provider,
      externalEventId: event.externalEventId ?? null,
      externalMessageId: event.externalMessageId,
      conversationId: existingConversation?.id ?? null,
      payloadJson: JSON.stringify(event.rawPayload ?? {}),
      status: 'processed',
      processedAt: new Date(),
    },
  });

  const text = event.text?.trim() ?? '';
  if (text.startsWith('/bind ')) {
    return handleBind(event, text.slice(6).trim());
  }

  const context = await requireBoundAccount(event);
  if (!context) {
    return { outputs: [{ text: 'Please bind your account first with /bind <code>.' }] };
  }

  if (text.startsWith('/')) {
    return handleCommand(context, event, text);
  }

  if (!context.conversation.taskId) {
    return createConversationTask({
      userId: context.account.userId,
      projectId: context.projectId,
      conversationId: context.conversation.id,
      boundDaemonName: context.conversation.boundDaemonName ?? context.providerConfig?.defaultDaemonName ?? null,
      daemons: getConnectedDaemons(context.account.userId),
      initialContent: text,
      metadata: { channel: { provider: event.provider, externalChatId: event.externalChatId } },
    });
  }

  await appendUserMessageToTask({
    userId: context.account.userId,
    taskId: context.conversation.taskId,
    content: text,
    role: 'user',
    metadata: { channel: { provider: event.provider, externalChatId: event.externalChatId, origin: 'im' } },
  });
  return { outputs: [] };
}
