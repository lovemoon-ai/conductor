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
  it('enforces required capabilities for every host delivery path', () => {
    const hub = new RealtimeHub();
    const legacySend = vi.fn();
    hub.register({
      id: 'legacy-agent', kind: 'agent', userId: 'user-1', projectIds: ['*'],
      host: 'daemon-a', capabilities: [], send: legacySend, close: vi.fn(),
    });
    const envelope = { type: 'task_user_message', payload: { required_capabilities: ['task_attachments_v1'] } };
    expect(hub.sendToAgentHost('user-1', 'daemon-a', envelope)).toBe(false);
    expect(legacySend).not.toHaveBeenCalled();
  });

  it('broadcasts user preference updates only to app connections for that user', () => {
    const hub = new RealtimeHub();
    const appSend = vi.fn();
    const otherUserSend = vi.fn();
    const agentSend = vi.fn();
    hub.register({
      id: 'app-1',
      kind: 'app',
      userId: 'user-1',
      projectIds: [],
      send: appSend,
      close: vi.fn(),
    });
    hub.register({
      id: 'app-2',
      kind: 'app',
      userId: 'user-2',
      projectIds: [],
      send: otherUserSend,
      close: vi.fn(),
    });
    hub.register({
      id: 'agent-1',
      kind: 'agent',
      userId: 'user-1',
      projectIds: ['*'],
      host: 'daemon-a',
      send: agentSend,
      close: vi.fn(),
    });

    expect(hub.broadcastToUser('user-1', { type: 'user_preference_update' })).toBe(1);
    expect(appSend).toHaveBeenCalledWith({ type: 'user_preference_update' });
    expect(otherUserSend).not.toHaveBeenCalled();
    expect(agentSend).not.toHaveBeenCalled();
  });

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
    hub.bindTaskToAgent('task-1', 'daemon-a', 'user-1');

    expect(hub.takeOverAgentHost('daemon-a', 'user-1')).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(hub.hasAgentHost('daemon-a', 'user-1')).toBe(false);
    expect(hub.getTaskAgentHost('task-1')).toBe('daemon-a');
    expect(hub.getAgentDisconnectAt('daemon-a', 'user-1')).toBeNull();
  });

  it('keeps the replacement binding when the replaced socket closes late', () => {
    // A fire keeps one identity across restarts, so the old and the new process
    // share a host name. `unregister` clears bindings by host, so the dying
    // socket's close callback must not evict the fire that already replaced it.
    const hub = new RealtimeHub();
    const host = 'conductor-fire-daemon-a-task-1';
    const registerFire = (id: string) => hub.register({
      id,
      kind: 'agent',
      userId: 'user-1',
      projectIds: ['*'],
      host,
      supportedBackends: ['claude'],
      capabilities: ['task_attachments_v1'],
      send: vi.fn(),
      close: vi.fn(),
    });

    registerFire('fire-old');
    hub.bindTaskToAgent('task-1', host, 'user-1');
    expect(hub.takeOverAgentHost(host, 'user-1')).toBe(1);
    registerFire('fire-new');
    hub.bindTaskToAgent('task-1', host, 'user-1');

    // The replaced socket's close event arrives only now.
    hub.unregister('fire-old');

    expect(hub.getTaskAgentHost('task-1')).toBe(host);
    expect(hub.hasAgentHost(host, 'user-1')).toBe(true);
    expect(hub.getAgentDisconnectAt(host, 'user-1')).toBeNull();
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

describe('RealtimeHub custom commands waiter', () => {
  it('resolves only when source userId+host match the registered waiter', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForCustomCommandsResponse('req-command-1', 5000, 'user-1', 'daemon-a');
    hub.resolveCustomCommandsResponse(
      { request_id: 'req-command-1', action: 'list', result: { commands: [] } },
      'user-1',
      'daemon-a',
    );
    const result = await pending;
    expect(result).toMatchObject({ request_id: 'req-command-1', action: 'list' });
  });

  it('drops custom command responses from a different host', async () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub();
      const pending = hub.waitForCustomCommandsResponse('req-command-2', 5000, 'user-1', 'daemon-a');
      hub.resolveCustomCommandsResponse(
        { request_id: 'req-command-2', action: 'status', result: { hijacked: true } },
        'user-1',
        'daemon-imposter',
      );
      vi.advanceTimersByTime(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelCustomCommandsResponse after resolve is a no-op', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForCustomCommandsResponse('req-command-3', 5000, 'user-1', 'daemon-a');
    hub.resolveCustomCommandsResponse(
      { request_id: 'req-command-3', action: 'run', result: { started: true } },
      'user-1',
      'daemon-a',
    );
    await pending;
    expect(() => hub.cancelCustomCommandsResponse('req-command-3')).not.toThrow();
  });
});

describe('RealtimeHub remote exec waiter', () => {
  it('resolves only when source userId+host match the registered waiter', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForRemoteExecResponse('req-exec-1', 5000, 'user-1', 'daemon-a');
    hub.resolveRemoteExecResponse(
      { request_id: 'req-exec-1', action: 'exec', result: { runId: 'run-1' } },
      'user-1',
      'daemon-a',
    );
    const result = await pending;
    expect(result).toMatchObject({ request_id: 'req-exec-1', action: 'exec' });
  });

  it('drops remote exec responses from a different user', async () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub();
      const pending = hub.waitForRemoteExecResponse('req-exec-2', 5000, 'user-1', 'daemon-a');
      hub.resolveRemoteExecResponse(
        { request_id: 'req-exec-2', action: 'exec', result: { hijacked: true } },
        'user-2',
        'daemon-a',
      );
      vi.advanceTimersByTime(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops remote exec responses from a different host', async () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub();
      const pending = hub.waitForRemoteExecResponse('req-exec-3', 5000, 'user-1', 'daemon-a');
      hub.resolveRemoteExecResponse(
        { request_id: 'req-exec-3', action: 'exec', result: { hijacked: true } },
        'user-1',
        'daemon-imposter',
      );
      vi.advanceTimersByTime(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves pending waiters for a daemon that disconnects', async () => {
    const hub = new RealtimeHub();
    hub.register({
      id: 'conn-1',
      kind: 'agent',
      userId: 'user-1',
      projectIds: [],
      host: 'daemon-a',
      send: () => {},
      close: () => {},
    } as never);

    const mine = hub.waitForRemoteExecResponse('req-drop', 60_000, 'user-1', 'daemon-a');
    const otherHost = hub.waitForRemoteExecResponse('req-other-host', 60_000, 'user-1', 'daemon-b');
    const otherUser = hub.waitForRemoteExecResponse('req-other-user', 60_000, 'user-2', 'daemon-a');

    hub.unregister('conn-1');

    expect(await mine).toBeNull();

    // Waiters addressed elsewhere must survive the sweep.
    let settled = false;
    void Promise.race([otherHost, otherUser]).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    hub.cancelRemoteExecResponse('req-other-host');
    hub.cancelRemoteExecResponse('req-other-user');
    await Promise.all([otherHost, otherUser]);
  });

  it('leaves waiters alone when another connection still serves the host', async () => {
    const hub = new RealtimeHub();
    const conn = (id: string) =>
      ({
        id,
        kind: 'agent',
        userId: 'user-1',
        projectIds: [],
        host: 'daemon-a',
        send: () => {},
        close: () => {},
      }) as never;
    hub.register(conn('conn-old'));
    hub.register(conn('conn-new'));

    const pending = hub.waitForRemoteExecResponse('req-reconnect', 60_000, 'user-1', 'daemon-a');
    hub.unregister('conn-old');

    hub.resolveRemoteExecResponse(
      { request_id: 'req-reconnect', action: 'exec', result: { runId: 'still-alive' } },
      'user-1',
      'daemon-a',
    );
    expect(await pending).toMatchObject({ request_id: 'req-reconnect' });
  });

  it('cancelRemoteExecResponse after resolve is a no-op', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForRemoteExecResponse('req-exec-4', 5000, 'user-1', 'daemon-a');
    hub.resolveRemoteExecResponse(
      { request_id: 'req-exec-4', action: 'status', result: { status: 'completed' } },
      'user-1',
      'daemon-a',
    );
    await pending;
    expect(() => hub.cancelRemoteExecResponse('req-exec-4')).not.toThrow();
  });
});

describe('RealtimeHub agent command ack waiter', () => {
  it('resolves true when any expected host accepts the command', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForAgentCommandAck('task-1', 'req-1', 5000, {
      expectedHosts: ['conductor-fire-a', 'conductor-fire-b'],
      eventType: 'interrupt_turn',
    });

    hub.acknowledgeAgentCommand('task-1', 'req-1', false, {
      agentHost: 'conductor-fire-a',
      eventType: 'interrupt_turn',
    });
    hub.acknowledgeAgentCommand('task-1', 'req-1', true, {
      agentHost: 'conductor-fire-b',
      eventType: 'interrupt_turn',
    });

    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when every expected host rejects the command', async () => {
    const hub = new RealtimeHub();
    const pending = hub.waitForAgentCommandAck('task-1', 'req-2', 5000, {
      expectedHosts: ['conductor-fire-a', 'conductor-fire-b'],
      eventType: 'interrupt_turn',
    });

    hub.acknowledgeAgentCommand('task-1', 'req-2', false, {
      agentHost: 'conductor-fire-a',
      eventType: 'interrupt_turn',
    });
    hub.acknowledgeAgentCommand('task-1', 'req-2', false, {
      agentHost: 'conductor-fire-b',
      eventType: 'interrupt_turn',
    });

    await expect(pending).resolves.toBe(false);
  });

  it('returns false on timeout after at least one expected host explicitly rejects', async () => {
    vi.useFakeTimers();
    try {
      const hub = new RealtimeHub();
      const pending = hub.waitForAgentCommandAck('task-1', 'req-3', 1000, {
        expectedHosts: ['conductor-fire-a', 'conductor-fire-b'],
        eventType: 'interrupt_turn',
      });

      hub.acknowledgeAgentCommand('task-1', 'req-3', false, {
        agentHost: 'conductor-fire-a',
        eventType: 'interrupt_turn',
      });

      vi.advanceTimersByTime(1000);

      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RealtimeHub task-id routing is scoped to the task owner', () => {
  const registerAgent = (
    hub: RealtimeHub,
    args: { id: string; userId: string; host: string },
  ) => {
    const send = vi.fn();
    hub.register({
      id: args.id,
      kind: 'agent',
      userId: args.userId,
      projectIds: ['*'],
      host: args.host,
      supportedBackends: ['claude'],
      capabilities: ['pty_task'],
      send,
      close: vi.fn(),
    });
    return send;
  };

  it('delivers to the owning tenant when two users share a daemon host name', () => {
    // `os.hostname()` is the daemon's default name, so two accounts commonly
    // both run a daemon called `MacBook-Pro.local`. `taskToAgent` only stores
    // the bare host, so an unscoped lookup would return whichever connection
    // Map iteration happens to reach first.
    const hub = new RealtimeHub();
    const sharedHost = 'MacBook-Pro.local';
    // Registered first, so it wins Map iteration order for the shared host.
    const strangerSend = registerAgent(hub, { id: 'agent-user-1', userId: 'user-1', host: sharedHost });
    const ownerSend = registerAgent(hub, { id: 'agent-user-2', userId: 'user-2', host: sharedHost });

    hub.bindTaskToAgent('task-pty-owned-by-user-2', sharedHost, 'user-2');

    const envelope = { type: 'terminal_input', payload: { data: 'secret-keystrokes' } };
    expect(hub.sendToAgent('user-2', 'task-pty-owned-by-user-2', envelope)).toBe(true);
    expect(ownerSend).toHaveBeenCalledWith(envelope);
    expect(strangerSend).not.toHaveBeenCalled();
  });

  it('refuses to deliver when only another tenant serves the bound host', () => {
    const hub = new RealtimeHub();
    const sharedHost = 'MacBook-Pro.local';
    const strangerSend = registerAgent(hub, { id: 'agent-user-1', userId: 'user-1', host: sharedHost });

    hub.bindTaskToAgent('task-pty-owned-by-user-2', sharedHost, 'user-2');

    expect(hub.sendToAgent('user-2', 'task-pty-owned-by-user-2', { type: 'terminal_input' })).toBe(false);
    expect(strangerSend).not.toHaveBeenCalled();
  });

  it('does not treat a blank userId as "any owner"', () => {
    const hub = new RealtimeHub();
    const send = registerAgent(hub, { id: 'agent-user-1', userId: 'user-1', host: 'daemon-a' });

    hub.bindTaskToAgent('task-1', 'daemon-a', 'user-1');

    expect(hub.sendToAgent('', 'task-1', { type: 'terminal_input' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('still routes fire-owned tasks to the fire host under the same user', () => {
    // A fire connects as its own agent under the same account as the daemon,
    // so owner scoping must not collapse the two hosts together.
    const hub = new RealtimeHub();
    const daemonSend = registerAgent(hub, { id: 'agent-daemon', userId: 'user-1', host: 'MacBook-Pro.local' });
    const fireSend = registerAgent(hub, {
      id: 'agent-fire',
      userId: 'user-1',
      host: 'conductor-fire-MacBook-Pro.local-task-1',
    });

    hub.bindTaskToAgent('task-1', 'conductor-fire-MacBook-Pro.local-task-1', 'user-1');

    const envelope = { type: 'terminal_resize', payload: { cols: 80, rows: 24 } };
    expect(hub.sendToAgent('user-1', 'task-1', envelope)).toBe(true);
    expect(fireSend).toHaveBeenCalledWith(envelope);
    expect(daemonSend).not.toHaveBeenCalled();
  });

  it('returns false when the task has no binding at all', () => {
    const hub = new RealtimeHub();
    registerAgent(hub, { id: 'agent-daemon', userId: 'user-1', host: 'daemon-a' });

    expect(hub.sendToAgent('user-1', 'unbound-task', { type: 'terminal_input' })).toBe(false);
  });
});

describe('RealtimeHub unbinds tasks scoped to the disconnecting agent owner', () => {
  const registerAgent = (
    hub: RealtimeHub,
    args: { id: string; userId: string; host: string },
  ) => {
    const send = vi.fn();
    hub.register({
      id: args.id,
      kind: 'agent',
      userId: args.userId,
      projectIds: ['*'],
      host: args.host,
      supportedBackends: ['claude'],
      capabilities: ['pty_task'],
      send,
      close: vi.fn(),
    });
    return send;
  };

  it("keeps another tenant's binding when a same-named daemon disconnects", () => {
    // A and B both run a daemon called `MacBook-Pro.local`. Evicting bindings
    // by bare host would drop B's live task when A merely goes offline.
    const hub = new RealtimeHub();
    const sharedHost = 'MacBook-Pro.local';
    registerAgent(hub, { id: 'agent-a', userId: 'user-a', host: sharedHost });
    const bSend = registerAgent(hub, { id: 'agent-b', userId: 'user-b', host: sharedHost });

    hub.bindTaskToAgent('task-owned-by-b', sharedHost, 'user-b');

    hub.unregister('agent-a');

    expect(hub.getTaskAgentHost('task-owned-by-b')).toBe(sharedHost);
    const envelope = { type: 'terminal_input', payload: { data: 'ls' } };
    expect(hub.sendToAgent('user-b', 'task-owned-by-b', envelope)).toBe(true);
    expect(bSend).toHaveBeenCalledWith(envelope);
  });

  it('still evicts the disconnecting owner’s own bindings', () => {
    const hub = new RealtimeHub();
    const sharedHost = 'MacBook-Pro.local';
    registerAgent(hub, { id: 'agent-a', userId: 'user-a', host: sharedHost });
    registerAgent(hub, { id: 'agent-b', userId: 'user-b', host: sharedHost });

    hub.bindTaskToAgent('task-owned-by-a', sharedHost, 'user-a');
    hub.bindTaskToAgent('task-owned-by-b', sharedHost, 'user-b');

    hub.unregister('agent-a');

    expect(hub.getTaskAgentHost('task-owned-by-a')).toBeNull();
    expect(hub.getTaskAgentHost('task-owned-by-b')).toBe(sharedHost);
  });

  it('restores bindings from the database with their owning user', async () => {
    const hub = new RealtimeHub();
    const sharedHost = 'MacBook-Pro.local';
    registerAgent(hub, { id: 'agent-a', userId: 'user-a', host: sharedHost });
    const bSend = registerAgent(hub, { id: 'agent-b', userId: 'user-b', host: sharedHost });

    const restored = await hub.restoreTaskBindingsFromDb(async () => [
      { id: 'task-owned-by-b', agentHost: sharedHost, userId: 'user-b' },
      // An unowned row cannot be routed or evicted safely, so it is skipped.
      { id: 'task-without-owner', agentHost: sharedHost, userId: null },
    ]);

    expect(restored).toBe(1);
    const envelope = { type: 'terminal_input', payload: { data: 'ls' } };
    expect(hub.sendToAgent('user-b', 'task-owned-by-b', envelope)).toBe(true);
    expect(bSend).toHaveBeenCalledWith(envelope);
    // The boot-restored binding must not be routable by the same-named foreign daemon.
    expect(hub.sendToAgent('user-a', 'task-owned-by-b', envelope)).toBe(false);
    expect(hub.sendToAgent('user-b', 'task-without-owner', envelope)).toBe(false);
  });
});
