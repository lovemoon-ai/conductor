import { describe, expect, it, vi } from 'vitest';
import { RealtimeHub } from './hub';

const registerApp = (hub: RealtimeHub, connectionId: string, userId = 'user-1') => {
  hub.register({
    id: connectionId,
    kind: 'app',
    userId,
    projectIds: ['*'],
    send: vi.fn(),
    close: vi.fn(),
  });
};

describe('RealtimeHub terminal writer leases', () => {
  it('keeps a single writer unless control is forced', () => {
    const hub = new RealtimeHub();
    registerApp(hub, 'conn-a');
    registerApp(hub, 'conn-b');

    expect(hub.attachTerminal('conn-a', 'task-pty-1')).toBe(true);
    expect(hub.attachTerminal('conn-b', 'task-pty-1')).toBe(true);

    expect(hub.requestTerminalWriter('task-pty-1', 'conn-a')).toMatchObject({
      granted: true,
      writerConnectionId: 'conn-a',
    });
    expect(hub.requestTerminalWriter('task-pty-1', 'conn-b')).toMatchObject({
      granted: false,
      writerConnectionId: 'conn-a',
    });
    expect(hub.getTerminalWriter('task-pty-1')).toBe('conn-a');

    expect(hub.requestTerminalWriter('task-pty-1', 'conn-b', { force: true })).toMatchObject({
      granted: true,
      writerConnectionId: 'conn-b',
    });
    expect(hub.getTerminalWriter('task-pty-1')).toBe('conn-b');
  });

  it('releases writer control when the writer detaches or disconnects', () => {
    const hub = new RealtimeHub();
    registerApp(hub, 'conn-a');
    registerApp(hub, 'conn-b');

    hub.attachTerminal('conn-a', 'task-pty-2');
    hub.attachTerminal('conn-b', 'task-pty-2');
    hub.requestTerminalWriter('task-pty-2', 'conn-a');

    expect(hub.detachTerminal('conn-a', 'task-pty-2')).toEqual({
      detachedTaskIds: ['task-pty-2'],
      releasedWriterTaskIds: ['task-pty-2'],
    });
    expect(hub.getTerminalWriter('task-pty-2')).toBeNull();
    expect(hub.getTerminalViewerCount('task-pty-2')).toBe(1);

    hub.requestTerminalWriter('task-pty-2', 'conn-b');
    expect(hub.getTerminalWriter('task-pty-2')).toBe('conn-b');

    expect(hub.unregister('conn-b')).toMatchObject({
      detachedTaskIds: ['task-pty-2'],
      releasedWriterTaskIds: ['task-pty-2'],
    });
    expect(hub.getTerminalWriter('task-pty-2')).toBeNull();
    expect(hub.getTerminalViewerCount('task-pty-2')).toBe(0);
  });
});

describe('RealtimeHub connected agents metadata', () => {
  it('preserves optional agent version metadata', () => {
    const hub = new RealtimeHub();
    hub.register({
      id: 'agent-1',
      kind: 'agent',
      userId: 'user-1',
      projectIds: ['*'],
      host: 'daemon-a',
      supportedBackends: ['codex'],
      runtimeBackendMap: { codex: 'codex' },
      capabilities: ['pty_task'],
      version: '0.2.21',
      send: vi.fn(),
      close: vi.fn(),
    });
    hub.register({
      id: 'agent-2',
      kind: 'agent',
      userId: 'user-1',
      projectIds: ['*'],
      host: 'daemon-b',
      supportedBackends: ['codex'],
      capabilities: ['pty_task'],
      send: vi.fn(),
      close: vi.fn(),
    });

    expect(hub.getAgentsForUser('user-1')).toEqual([
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['codex'],
        runtimeBackendMap: { codex: 'codex' },
        capabilities: ['pty_task'],
        version: '0.2.21',
      },
      {
        id: 'agent-2',
        host: 'daemon-b',
        supportedBackends: ['codex'],
        capabilities: ['pty_task'],
        version: undefined,
      },
    ]);
  });

  it('allows a new agent connection to take over the same host without dropping bindings', () => {
    const hub = new RealtimeHub();
    const close = vi.fn();
    hub.register({
      id: 'agent-1',
      kind: 'agent',
      userId: 'user-1',
      projectIds: ['*'],
      host: 'daemon-a',
      supportedBackends: ['codex'],
      capabilities: ['pty_task'],
      send: vi.fn(),
      close,
    });
    hub.bindTaskToAgent('task-1', 'daemon-a');

    expect(hub.takeOverAgentHost('daemon-a', 'user-1')).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(hub.hasAgentHost('daemon-a', 'user-1')).toBe(false);
    expect(hub.getTaskAgentHost('task-1')).toBe('daemon-a');
    expect(hub.getAgentDisconnectAt('daemon-a', 'user-1')).toBeNull();
  });
});

describe('RealtimeHub ai_manager waiter', () => {
  it('resolves when source userId+host match the registered waiter', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForAiManagerResponse('req-1', 5000, 'user-1', 'daemon-a');
    hub.resolveAiManagerResponse(
      { request_id: 'req-1', action: 'status', result: { ok: true } },
      'user-1',
      'daemon-a',
    );
    const result = await pending;
    expect(result).toMatchObject({ request_id: 'req-1', action: 'status' });
  });

  it('drops responses from a different host (cross-host safety)', async () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub();
      const pending = hub.waitForAiManagerResponse('req-2', 5000, 'user-1', 'daemon-a');
      // Imposter daemon resolves with a guessed request_id.
      hub.resolveAiManagerResponse(
        { request_id: 'req-2', action: 'status', result: { hijacked: true } },
        'user-1',
        'daemon-imposter',
      );
      vi.advanceTimersByTime(5000);
      const result = await pending;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops responses from a different user even if host matches', async () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub();
      const pending = hub.waitForAiManagerResponse('req-3', 5000, 'user-1', 'daemon-a');
      hub.resolveAiManagerResponse(
        { request_id: 'req-3', action: 'status', result: { x: 1 } },
        'user-2',
        'daemon-a',
      );
      vi.advanceTimersByTime(5000);
      const result = await pending;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelAiManagerResponse after resolve is a no-op', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForAiManagerResponse('req-4', 5000, 'user-1', 'daemon-a');
    hub.resolveAiManagerResponse(
      { request_id: 'req-4', action: 'quota', result: {} },
      'user-1',
      'daemon-a',
    );
    await pending;
    expect(() => hub.cancelAiManagerResponse('req-4')).not.toThrow();
  });

  it('returns null on timeout', async () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub();
      const pending = hub.waitForAiManagerResponse('req-5', 1000, 'user-1', 'daemon-a');
      vi.advanceTimersByTime(1000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
