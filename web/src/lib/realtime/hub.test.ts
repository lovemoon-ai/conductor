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
});
