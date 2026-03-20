import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockVerificationCreate,
  mockVerificationFindFirst,
  mockVerificationUpdate,
  mockProjectFindFirst,
  mockProjectFindMany,
  mockExternalAccountUpsert,
  mockExternalAccountFindFirst,
  mockChannelConversationFindFirst,
  mockChannelConversationUpsert,
  mockChannelConversationUpdate,
  mockChannelInboxCreate,
  mockChannelInboxFindFirst,
  mockChannelOutboxCreate,
  mockTaskFindMany,
  mockTaskFindFirst,
  mockMessageFindMany,
  mockTaskUpdate,
  mockEnqueueAndAttemptAgentCommand,
  mockCreateTaskForUser,
  mockAppendUserMessageToTask,
  mockGetAgentsForUser,
  mockGetFeishuProviderConfigForUser,
} = vi.hoisted(() => ({
  mockVerificationCreate: vi.fn(),
  mockVerificationFindFirst: vi.fn(),
  mockVerificationUpdate: vi.fn(),
  mockProjectFindFirst: vi.fn(),
  mockProjectFindMany: vi.fn(),
  mockExternalAccountUpsert: vi.fn(),
  mockExternalAccountFindFirst: vi.fn(),
  mockChannelConversationFindFirst: vi.fn(),
  mockChannelConversationUpsert: vi.fn(),
  mockChannelConversationUpdate: vi.fn(),
  mockChannelInboxCreate: vi.fn(),
  mockChannelInboxFindFirst: vi.fn(),
  mockChannelOutboxCreate: vi.fn(),
  mockTaskFindMany: vi.fn(),
  mockTaskFindFirst: vi.fn(),
  mockMessageFindMany: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockEnqueueAndAttemptAgentCommand: vi.fn(),
  mockCreateTaskForUser: vi.fn(),
  mockAppendUserMessageToTask: vi.fn(),
  mockGetAgentsForUser: vi.fn(),
  mockGetFeishuProviderConfigForUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    verification: {
      create: mockVerificationCreate,
      findFirst: mockVerificationFindFirst,
      update: mockVerificationUpdate,
    },
    project: {
      findFirst: mockProjectFindFirst,
      findMany: mockProjectFindMany,
    },
    externalAccount: {
      upsert: mockExternalAccountUpsert,
      findFirst: mockExternalAccountFindFirst,
    },
    channelConversation: {
      findFirst: mockChannelConversationFindFirst,
      upsert: mockChannelConversationUpsert,
      update: mockChannelConversationUpdate,
    },
    channelInbox: {
      create: mockChannelInboxCreate,
      findFirst: mockChannelInboxFindFirst,
    },
    channelOutbox: {
      create: mockChannelOutboxCreate,
    },
    task: {
      findMany: mockTaskFindMany,
      findFirst: mockTaskFindFirst,
      update: mockTaskUpdate,
    },
    message: {
      findMany: mockMessageFindMany,
    },
  },
}));

vi.mock('@/lib/realtime/agent-outbox', () => ({
  enqueueAndAttemptAgentCommand: mockEnqueueAndAttemptAgentCommand,
}));

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: {
    getAgentsForUser: mockGetAgentsForUser,
  },
}));

vi.mock('./task-ingress-service', () => ({
  createTaskForUser: mockCreateTaskForUser,
  appendUserMessageToTask: mockAppendUserMessageToTask,
}));

vi.mock('./provider-config', () => ({
  getFeishuProviderConfigForUser: mockGetFeishuProviderConfigForUser,
}));

const {
  issueBindCode,
  handleNormalizedInboundEvent,
  enqueueChannelMessage,
} = await import('./service');

describe('channel core service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerificationCreate.mockResolvedValue({ code: 'ABC123' });
    mockProjectFindFirst.mockResolvedValue({ id: 'proj-1', userId: 'user-1', name: 'Default Project', metadata: JSON.stringify({ isDefault: true }) });
    mockProjectFindMany.mockResolvedValue([]);
    mockExternalAccountUpsert.mockResolvedValue({ id: 'ext-1', userId: 'user-1' });
    mockExternalAccountFindFirst.mockResolvedValue({ id: 'ext-1', userId: 'user-1', provider: 'FEISHU', externalUserId: 'ou_1' });
    mockChannelConversationFindFirst.mockResolvedValue(null);
    mockChannelConversationUpsert.mockResolvedValue({ id: 'conv-1', taskId: null, userId: 'user-1', projectId: 'proj-1', externalChatId: 'oc_1', boundDaemonName: 'daemon-a' });
    mockChannelConversationUpdate.mockResolvedValue({ id: 'conv-1', taskId: 'task-1', boundDaemonName: 'daemon-a' });
    mockChannelInboxCreate.mockResolvedValue({ id: 'inbox-1' });
    mockChannelInboxFindFirst.mockResolvedValue(null);
    mockChannelOutboxCreate.mockResolvedValue({ id: 'out-1' });
    mockTaskFindMany.mockResolvedValue([]);
    mockTaskFindFirst.mockResolvedValue({ id: 'task-1', projectId: 'proj-1' });
    mockMessageFindMany.mockResolvedValue([]);
    mockTaskUpdate.mockResolvedValue({ id: 'task-1', status: 'killed' });
    mockEnqueueAndAttemptAgentCommand.mockResolvedValue({ requestId: 'req-1', delivered: false });
    mockCreateTaskForUser.mockResolvedValue({
      task: {
        id: 'task-1',
        projectId: 'proj-1',
        status: 'running',
        agentHost: 'daemon-a',
        backendType: 'claude',
        sessionId: null,
      },
    });
    mockAppendUserMessageToTask.mockResolvedValue({ task: { id: 'task-1', projectId: 'proj-1' }, message: { id: 'msg-1' } });
    mockGetAgentsForUser.mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude', 'codex'] },
      { id: 'agent-2', host: 'daemon-b', supportedBackends: ['codex'] },
      { id: 'agent-3', host: 'conductor-fire-debug', supportedBackends: ['claude'] },
    ]);
    mockGetFeishuProviderConfigForUser.mockResolvedValue({
      provider: 'FEISHU',
      userId: 'user-1',
      appId: 'cli_a',
      appSecret: 'cli_s',
      verificationToken: 'verify_t',
      encryptKey: 'encrypt_k',
      defaultDaemonName: 'daemon-a',
    });
  });

  it('issues a one-time bind code for a user', async () => {
    const result = await issueBindCode('user-1');

    expect(result.code).toHaveLength(6);
    expect(mockVerificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'CHANNEL_BIND',
      }),
    }));
  });

  it('binds a feishu dm account and creates a conversation on /bind', async () => {
    mockVerificationFindFirst.mockResolvedValue({ id: 'ver-1', userId: 'user-1', expiresAt: new Date(Date.now() + 60_000), verified: false });

    const result = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_1',
      externalEventId: 'evt_1',
      conversationType: 'dm',
      mentionsBot: false,
      text: '/bind ABC123',
      rawPayload: { event: true },
    });

    expect(mockVerificationUpdate).toHaveBeenCalledWith({ where: { id: 'ver-1' }, data: { verified: true } });
    expect(mockExternalAccountUpsert).toHaveBeenCalled();
    expect(mockChannelConversationUpsert).toHaveBeenCalled();
    expect(result.outputs[0].text).toContain('bound');
  });

  it('creates a new task on first dm message only after resolving the bound daemon and replies with daemon status', async () => {
    const result = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_2',
      externalEventId: 'evt_2',
      conversationType: 'dm',
      mentionsBot: false,
      text: 'hello from feishu',
      rawPayload: { event: true },
    });

    expect(mockCreateTaskForUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      projectId: 'proj-1',
      initialContent: 'hello from feishu',
      agentHost: 'daemon-a',
      backendType: 'claude',
    }));
    expect(mockChannelConversationUpsert).toHaveBeenCalled();
    expect(result.outputs[0].text).toContain('Task task-1 created');
    expect(result.outputs[0].text).toContain('daemon-a');
    expect(result.outputs[0].text).toContain('claude');
    expect(result.outputs[0].text).toContain('pending');
  });

  it('lists tasks and switches the current conversation task using /task', async () => {
    mockChannelConversationFindFirst.mockResolvedValue({ id: 'conv-1', taskId: 'task-old', userId: 'user-1', projectId: 'proj-1', boundDaemonName: 'daemon-a' });
    mockTaskFindMany.mockResolvedValue([
      { id: 'task-1', title: 'First', status: 'running', updatedAt: new Date('2026-03-16T01:00:00.000Z') },
      { id: 'task-2', title: 'Second', status: 'completed', updatedAt: new Date('2026-03-16T02:00:00.000Z') },
    ]);
    mockMessageFindMany.mockResolvedValue([
      { id: 'msg-1', taskId: 'task-2', role: 'user', content: 'hello', createdAt: new Date('2026-03-16T02:00:00.000Z'), metadata: null },
    ]);

    const tasksResult = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_3',
      externalEventId: 'evt_3',
      conversationType: 'dm',
      mentionsBot: false,
      text: '/tasks recent',
      rawPayload: {},
    });
    expect(tasksResult.outputs[0].text).toContain('Second');

    const switchResult = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_4',
      externalEventId: 'evt_4',
      conversationType: 'dm',
      mentionsBot: false,
      text: '/task task-2',
      rawPayload: {},
    });
    expect(mockChannelConversationUpdate).toHaveBeenCalledWith({ where: { id: 'conv-1' }, data: { taskId: 'task-2' } });
    expect(switchResult.outputs[0].text).toContain('task-2');
    expect(switchResult.outputs[0].text).toContain('hello');
  });

  it('lists online daemons and marks the current bound daemon with /daemons', async () => {
    mockChannelConversationFindFirst.mockResolvedValue({ id: 'conv-1', taskId: null, userId: 'user-1', projectId: 'proj-1', boundDaemonName: 'daemon-b' });

    const result = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_5',
      externalEventId: 'evt_5',
      conversationType: 'dm',
      mentionsBot: false,
      text: '/daemons',
      rawPayload: {},
    });

    expect(result.outputs[0].text).toContain('daemon-a');
    expect(result.outputs[0].text).toContain('daemon-b');
    expect(result.outputs[0].text).toContain('current');
  });

  it('switches the conversation daemon with /use-daemon', async () => {
    mockChannelConversationFindFirst.mockResolvedValue({ id: 'conv-1', taskId: null, userId: 'user-1', projectId: 'proj-1', boundDaemonName: 'daemon-a' });

    const result = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_6',
      externalEventId: 'evt_6',
      conversationType: 'dm',
      mentionsBot: false,
      text: '/use-daemon daemon-b',
      rawPayload: {},
    });

    expect(mockChannelConversationUpdate).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { boundDaemonName: 'daemon-b' },
    });
    expect(result.outputs[0].text).toContain('daemon-b');
  });

  it('does not create a task when no bound daemon is available', async () => {
    mockChannelConversationUpsert.mockResolvedValue({ id: 'conv-1', taskId: null, userId: 'user-1', projectId: 'proj-1', externalChatId: 'oc_1', boundDaemonName: 'missing-daemon' });
    mockGetFeishuProviderConfigForUser.mockResolvedValue({
      provider: 'FEISHU',
      userId: 'user-1',
      appId: 'cli_a',
      appSecret: 'cli_s',
      verificationToken: 'verify_t',
      encryptKey: 'encrypt_k',
      defaultDaemonName: 'missing-daemon',
    });

    const result = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_7',
      externalEventId: 'evt_7',
      conversationType: 'dm',
      mentionsBot: false,
      text: 'please create task',
      rawPayload: {},
    });

    expect(mockCreateTaskForUser).not.toHaveBeenCalled();
    expect(result.outputs[0].text).toContain('no available daemon');
  });

  it('returns a friendly error when /task points to an inaccessible task', async () => {
    mockChannelConversationFindFirst.mockResolvedValue({ id: 'conv-1', taskId: null, userId: 'user-1', projectId: 'proj-1', boundDaemonName: 'daemon-a' });
    mockTaskFindFirst.mockResolvedValue(null);

    const result = await handleNormalizedInboundEvent({
      provider: 'FEISHU',
      externalUserId: 'ou_1',
      externalChatId: 'oc_1',
      externalMessageId: 'om_8',
      externalEventId: 'evt_8',
      conversationType: 'dm',
      mentionsBot: false,
      text: '/task task-missing',
      rawPayload: {},
    });

    expect(result.outputs[0].text).toContain('Task not found or not accessible');
  });

  it('enqueues channel outbox rows with provider target fields', async () => {
    await enqueueChannelMessage({
      provider: 'FEISHU',
      userId: 'user-1',
      conversationId: 'conv-1',
      taskId: 'task-1',
      targetChatId: 'oc_1',
      targetReplyMessageId: 'om_1',
      kind: 'assistant_message',
      text: 'done',
      dedupeKey: 'dedupe-1',
    });

    expect(mockChannelOutboxCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        provider: 'FEISHU',
        conversationId: 'conv-1',
        targetChatId: 'oc_1',
        dedupeKey: 'dedupe-1',
      }),
    }));
  });
});
