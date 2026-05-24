import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {},
}));

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    bindTaskToAgent: vi.fn(),
    sendToAgentHost: vi.fn().mockReturnValue(true),
    getTaskAgentHost: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('@/lib/realtime/agent-outbox', () => ({
  enqueueAndAttemptAgentCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/issues/persist-ai-session', () => ({
  persistIssueAiSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/subscription/plan-limits', () => ({
  isConductorFireHost: vi.fn().mockReturnValue(false),
}));

const { createAiTaskArtifacts, finalizeAiTaskCreation } = await import('./create-ai-task');
const { enqueueAndAttemptAgentCommand } = await import('@/lib/realtime/agent-outbox');

const buildDbClient = () => {
  const createdTask = {
    id: 'task-1',
    projectId: 'project-1',
    issueId: 'issue-1',
    title: 'Build it',
    status: 'init',
    taskType: 'ai_task',
    agentHost: 'daemon-a',
    executionHost: 'daemon-a',
    backendType: 'claude',
    sessionId: null,
    sessionFilePath: null,
    launchConfig: null,
    metadata: null,
    createdAt: new Date('2026-04-14T00:00:00Z'),
    updatedAt: new Date('2026-04-14T00:00:00Z'),
  };

  const task = {
    create: vi.fn().mockResolvedValue(createdTask),
    update: vi.fn().mockResolvedValue({ ...createdTask, updatedAt: new Date('2026-04-14T00:01:00Z') }),
  };
  const message = {
    create: vi.fn().mockResolvedValue({ id: 'msg-1', createdAt: new Date('2026-04-14T00:00:30Z') }),
  };
  const issue = {
    update: vi.fn().mockResolvedValue(undefined),
  };
  return { task, message, issue, createdTask };
};

describe('createAiTaskArtifacts (goal mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges aiMode and goal into the persisted launchConfig', async () => {
    const dbClient = buildDbClient();

    await createAiTaskArtifacts(
      {
        userId: 'user-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        agentHost: 'daemon-a',
        requestedBackendType: 'claude',
        launchConfig: { cwd: '/repo' },
        metadata: { backendType: 'claude' },
        initialMessageContent: 'ship the feature',
        aiMode: 'goal',
        goal: {
          objective: 'ship the feature',
          source: 'issue',
          issueId: 'issue-1',
        },
      },
      dbClient as any,
    );

    const created = dbClient.task.create.mock.calls.at(-1)?.[0];
    expect(created).toBeDefined();
    const launchConfigJson = created?.data?.launchConfig as string | null;
    expect(typeof launchConfigJson).toBe('string');
    const launchConfig = JSON.parse(launchConfigJson ?? 'null');
    expect(launchConfig).toEqual({
      cwd: '/repo',
      aiMode: 'goal',
      goal: {
        objective: 'ship the feature',
        source: 'issue',
        issueId: 'issue-1',
      },
    });

    const metadataJson = created?.data?.metadata as string | null;
    expect(typeof metadataJson).toBe('string');
    const metadata = JSON.parse(metadataJson ?? 'null');
    expect(metadata).toEqual({
      backendType: 'claude',
      aiMode: 'goal',
      goal: {
        source: 'issue',
        status: 'created',
        issueId: 'issue-1',
      },
    });
  });

  it('stamps message.metadata.goal = true on the initial message in goal mode', async () => {
    const dbClient = buildDbClient();

    await createAiTaskArtifacts(
      {
        userId: 'user-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        agentHost: 'daemon-a',
        requestedBackendType: 'claude',
        launchConfig: null,
        metadata: null,
        initialMessageContent: 'ship the feature',
        aiMode: 'goal',
        goal: {
          objective: 'ship the feature',
          source: 'issue',
          issueId: 'issue-1',
        },
      },
      dbClient as any,
    );

    const messageData = dbClient.message.create.mock.calls.at(-1)?.[0]?.data;
    expect(messageData).toMatchObject({ role: 'user', content: 'ship the feature' });
    expect(typeof messageData.metadata).toBe('string');
    expect(JSON.parse(messageData.metadata)).toEqual({ goal: true });
  });

  it('defensive guard (N6): does NOT stamp metadata.aiMode when goal.objective is empty', async () => {
    const dbClient = buildDbClient();

    await createAiTaskArtifacts(
      {
        userId: 'user-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        agentHost: 'daemon-a',
        requestedBackendType: 'claude',
        launchConfig: null,
        metadata: { backendType: 'claude' },
        initialMessageContent: 'hello',
        aiMode: 'goal',
        // Caller forgot to set goal.objective — this is the bug N6 catches.
        goal: { objective: '   ', source: 'issue', issueId: 'issue-1' },
      },
      dbClient as any,
    );

    const created = dbClient.task.create.mock.calls.at(-1)?.[0];
    const metadata = JSON.parse((created?.data?.metadata as string) ?? 'null');
    // We expect aiMode NOT to be stamped because there is no real objective.
    expect(metadata).not.toHaveProperty('aiMode');
    expect(metadata).not.toHaveProperty('goal');
    expect(metadata.backendType).toBe('claude');
  });

  it('defensive guard (N6): does NOT stamp metadata.aiMode when goal is missing entirely', async () => {
    const dbClient = buildDbClient();

    await createAiTaskArtifacts(
      {
        userId: 'user-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        agentHost: 'daemon-a',
        requestedBackendType: 'claude',
        launchConfig: null,
        metadata: { backendType: 'claude' },
        initialMessageContent: 'hello',
        aiMode: 'goal',
        goal: null,
      },
      dbClient as any,
    );

    const created = dbClient.task.create.mock.calls.at(-1)?.[0];
    const metadata = JSON.parse((created?.data?.metadata as string) ?? 'null');
    expect(metadata).not.toHaveProperty('aiMode');
    expect(metadata).not.toHaveProperty('goal');
  });

  it('positive (N6): stamps metadata.aiMode when goal.objective is a valid non-empty string', async () => {
    const dbClient = buildDbClient();

    await createAiTaskArtifacts(
      {
        userId: 'user-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        agentHost: 'daemon-a',
        requestedBackendType: 'claude',
        launchConfig: null,
        metadata: { backendType: 'claude' },
        initialMessageContent: 'real objective',
        aiMode: 'goal',
        goal: { objective: 'real objective', source: 'issue', issueId: 'issue-1' },
      },
      dbClient as any,
    );

    const created = dbClient.task.create.mock.calls.at(-1)?.[0];
    const metadata = JSON.parse((created?.data?.metadata as string) ?? 'null');
    expect(metadata.aiMode).toBe('goal');
    expect(metadata.goal).toEqual({
      source: 'issue',
      status: 'created',
      issueId: 'issue-1',
    });
  });

  it('leaves launchConfig and message metadata untouched when aiMode is omitted', async () => {
    const dbClient = buildDbClient();

    await createAiTaskArtifacts(
      {
        userId: 'user-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        agentHost: 'daemon-a',
        requestedBackendType: 'claude',
        launchConfig: { cwd: '/repo' },
        metadata: { backendType: 'claude' },
        initialMessageContent: 'hello',
      },
      dbClient as any,
    );

    const created = dbClient.task.create.mock.calls.at(-1)?.[0];
    const launchConfig = JSON.parse((created?.data?.launchConfig as string) ?? 'null');
    expect(launchConfig).toEqual({ cwd: '/repo' });
    const metadata = JSON.parse((created?.data?.metadata as string) ?? 'null');
    expect(metadata).toEqual({ backendType: 'claude' });

    const messageData = dbClient.message.create.mock.calls.at(-1)?.[0]?.data;
    expect(messageData).not.toHaveProperty('metadata');
  });
});

describe('finalizeAiTaskCreation (goal mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards launch_config.aiMode + launch_config.goal in the dispatch envelope', async () => {
    await finalizeAiTaskCreation({
      userId: 'user-1',
      projectId: 'project-1',
      issueId: 'issue-1',
      title: 'Build it',
      agentHost: 'daemon-a',
      requestedBackendType: 'claude',
      launchConfig: { cwd: '/repo' },
      metadata: { backendType: 'claude' },
      initialMessageContent: 'ship the feature',
      aiMode: 'goal',
      goal: {
        objective: 'ship the feature',
        source: 'issue',
        issueId: 'issue-1',
      },
      task: {
        id: 'task-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        taskType: 'ai_task',
        status: 'init',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
        backendType: 'claude',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      initialMessage: { id: 'msg-1', createdAt: new Date() },
      effectiveLaunchConfig: {
        cwd: '/repo',
        aiMode: 'goal',
        goal: {
          objective: 'ship the feature',
          source: 'issue',
          issueId: 'issue-1',
        },
      },
    } as any);

    const call = vi.mocked(enqueueAndAttemptAgentCommand).mock.calls.at(-1)?.[0];
    expect(call).toBeDefined();
    const launchConfig = call?.envelope?.payload?.launch_config as Record<string, unknown> | undefined;
    expect(launchConfig).toEqual({
      cwd: '/repo',
      aiMode: 'goal',
      goal: {
        objective: 'ship the feature',
        source: 'issue',
        issueId: 'issue-1',
      },
    });
  });
});

describe('createAiTaskArtifacts + finalizeAiTaskCreation (dedup)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns effectiveLaunchConfig so finalize never recomputes (no drift)', async () => {
    const dbClient = buildDbClient();

    const artifacts = await createAiTaskArtifacts(
      {
        userId: 'user-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Build it',
        agentHost: 'daemon-a',
        requestedBackendType: 'claude',
        launchConfig: { cwd: '/repo' },
        metadata: { backendType: 'claude' },
        initialMessageContent: 'ship the feature',
        aiMode: 'goal',
        goal: {
          objective: 'ship the feature',
          source: 'issue',
          issueId: 'issue-1',
        },
      },
      dbClient as any,
    );

    // artifact carries the already-merged launchConfig
    expect(artifacts.effectiveLaunchConfig).toEqual({
      cwd: '/repo',
      aiMode: 'goal',
      goal: {
        objective: 'ship the feature',
        source: 'issue',
        issueId: 'issue-1',
      },
    });

    // Finalize is called with the artifact spread in — verify the dispatch
    // envelope reuses `effectiveLaunchConfig` byte-for-byte even if the
    // caller's original `args.launchConfig` would have produced something
    // different (here we deliberately mutate to prove finalize did not recompute).
    await finalizeAiTaskCreation({
      userId: 'user-1',
      projectId: 'project-1',
      issueId: 'issue-1',
      title: 'Build it',
      agentHost: 'daemon-a',
      requestedBackendType: 'claude',
      // SHADOW the original — should be ignored when effectiveLaunchConfig is present
      launchConfig: { cwd: '/somewhere-else', aiMode: 'goal', goal: { objective: 'DRIFTED', source: 'issue' } },
      metadata: { backendType: 'claude' },
      initialMessageContent: 'ship the feature',
      aiMode: 'goal',
      goal: {
        objective: 'DRIFTED',
        source: 'issue',
        issueId: 'issue-1',
      },
      ...artifacts,
    } as any);

    const call = vi.mocked(enqueueAndAttemptAgentCommand).mock.calls.at(-1)?.[0];
    const launchConfig = call?.envelope?.payload?.launch_config as Record<string, unknown> | undefined;
    expect(launchConfig).toEqual(artifacts.effectiveLaunchConfig);
    expect((launchConfig as any)?.goal?.objective).toBe('ship the feature');
  });
});
