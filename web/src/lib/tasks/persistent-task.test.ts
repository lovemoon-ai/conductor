import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    task: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: { broadcast: vi.fn() },
}));

const { db } = await import('@/lib/db');
const { realtimeHub } = await import('@/lib/realtime/hub');
const {
  buildPersistentRoundPrompt,
  capturePersistentRoundSummary,
  MAX_PERSISTENT_TEXT_LENGTH,
  readPersistentSettingsInput,
  updateTaskMetadata,
  withPersistentState,
} = await import('./persistent-task');
const { readPersistentTaskState, shouldShowPersistentTasks } = await import(
  '@/shared/utils/persistent-task'
);

describe('persistent task metadata', () => {
  it('reads defaults and ignores malformed values', () => {
    expect(readPersistentTaskState(null)).toBeNull();
    expect(readPersistentTaskState({ persistent: { enabled: true, round: 0 } })).toEqual({
      enabled: true,
      instructions: '',
      summary: '',
      round: 1,
      roundEndedAt: null,
      roundEndMessageId: null,
    });
  });

  it('merges into metadata.persistent without touching other keys', () => {
    const next = withPersistentState(
      { daemonName: 'mac-mini', persistent: { enabled: true, summary: 'old', round: 2 } },
      { summary: 'new' },
    );
    expect(next).toEqual({
      daemonName: 'mac-mini',
      persistent: { enabled: true, summary: 'new', round: 2 },
    });
  });

  it('shows persistent tasks unless the project turned it off', () => {
    expect(shouldShowPersistentTasks(null)).toBe(true);
    expect(shouldShowPersistentTasks({ showPersistentTasks: true })).toBe(true);
    expect(shouldShowPersistentTasks({ showPersistentTasks: false })).toBe(false);
  });

  it('validates settings input', () => {
    expect(readPersistentSettingsInput({ enabled: true, instructions: 'x' })).toEqual({
      enabled: true,
      instructions: 'x',
    });
    expect(readPersistentSettingsInput({ enabled: 'yes' })).toEqual({ error: 'enabled must be a boolean' });
    expect(readPersistentSettingsInput({ summary: 'x'.repeat(MAX_PERSISTENT_TEXT_LENGTH + 1) })).toHaveProperty('error');
    expect(readPersistentSettingsInput({})).toHaveProperty('error');
  });
});

describe('buildPersistentRoundPrompt', () => {
  it('carries instructions and summary ahead of the message', () => {
    const prompt = buildPersistentRoundPrompt({
      round: 3,
      instructions: 'Release the web app.',
      summary: 'Last release: 0.13.0',
      content: 'Ship 0.14.0',
    });
    expect(prompt).toContain('round 3');
    expect(prompt).toContain('Standing instructions:\nRelease the web app.');
    expect(prompt).toContain('Summary of previous rounds:\nLast release: 0.13.0');
    expect(prompt.endsWith('---\nShip 0.14.0')).toBe(true);
  });

  it('omits empty sections', () => {
    const prompt = buildPersistentRoundPrompt({ round: 2, instructions: ' ', summary: '', content: 'go' });
    expect(prompt).not.toContain('Standing instructions');
    expect(prompt).not.toContain('Summary of previous rounds');
  });
});

describe('updateTaskMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries when another writer changed the metadata in between', async () => {
    vi.mocked(db.task.findUnique)
      .mockResolvedValueOnce({ metadata: '{"a":1}', status: 'running', projectId: 'p1' } as never)
      .mockResolvedValueOnce({ metadata: '{"a":1,"labelIds":["l1"]}', status: 'running', projectId: 'p1' } as never);
    vi.mocked(db.task.updateMany)
      .mockResolvedValueOnce({ count: 0 } as never)
      .mockResolvedValueOnce({ count: 1 } as never);

    const result = await updateTaskMetadata(db.task, 'task-1', (metadata) => ({ ...metadata, b: 2 }));

    expect(result?.metadata).toEqual({ a: 1, labelIds: ['l1'], b: 2 });
    expect(vi.mocked(db.task.updateMany).mock.calls[1][0]).toMatchObject({
      where: { id: 'task-1', metadata: '{"a":1,"labelIds":["l1"]}' },
    });
  });
});

describe('capturePersistentRoundSummary', () => {
  const pendingMetadata = JSON.stringify({
    labelIds: ['l1'],
    persistent: { enabled: true, round: 2, roundEndMessageId: 'req-1' },
  });
  const capture = (content: string, messageMetadata: Record<string, unknown>) =>
    capturePersistentRoundSummary({
      userId: 'user-1',
      taskId: 'task-1',
      taskMetadata: pendingMetadata,
      content,
      messageMetadata,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.task.findUnique).mockResolvedValue({
      metadata: pendingMetadata,
      status: 'running',
      projectId: 'project-1',
    } as never);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it('stores the reply to the pending summary request and tells other clients', async () => {
    await capture('  Released 0.14.0  ', { reply_to: 'req-1' });

    const written = JSON.parse(vi.mocked(db.task.updateMany).mock.calls[0][0].data.metadata as string);
    expect(written.labelIds).toEqual(['l1']);
    expect(written.persistent.summary).toBe('Released 0.14.0');
    expect(realtimeHub.broadcast).toHaveBeenCalledWith('user-1', 'project-1', {
      type: 'task_status_update',
      payload: expect.objectContaining({ task_id: 'task-1', status: 'running', metadata: written }),
    });
  });

  it('caps an oversized summary', async () => {
    await capture('x'.repeat(MAX_PERSISTENT_TEXT_LENGTH + 500), { reply_to: 'req-1' });
    const written = JSON.parse(vi.mocked(db.task.updateMany).mock.calls[0][0].data.metadata as string);
    expect(written.persistent.summary).toHaveLength(MAX_PERSISTENT_TEXT_LENGTH + 1);
  });

  it('ignores unrelated replies and status lines without touching the database', async () => {
    await capture('hello', { reply_to: 'other' });
    await capture('boom', { reply_to: 'req-1', severity: 'error' });
    await capture('Conversation interrupted', { reply_to: 'req-1', interrupted: true });
    await capture('(claude 未返回任何文本)', { reply_to: 'req-1' });
    expect(db.task.findUnique).not.toHaveBeenCalled();
    expect(db.task.updateMany).not.toHaveBeenCalled();
  });
});
