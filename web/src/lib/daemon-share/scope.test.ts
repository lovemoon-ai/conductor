import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above module-level consts, so the factory must close
// over something created by `vi.hoisted`.
const mockDb = vi.hoisted(() => ({
  userToken: { findMany: vi.fn() },
  daemonShare: { findFirst: vi.fn() },
  task: { findFirst: vi.fn() },
  project: { findFirst: vi.fn() },
  issue: { findFirst: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import {
  isDaemonShareUser,
  normalizeSharePath,
  isPathAllowedForDaemonShare,
  isResourceInShareScope,
  isShareHostAllowed,
  resolveActiveShareForToken,
} from './scope';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isPathAllowedForDaemonShare', () => {
  it('allows the routes the daemon and fire actually call', () => {
    for (const path of [
      '/api/agents',
      '/api/tasks',
      '/api/tasks/abc-123',
      '/api/tasks/abc-123/messages',
      '/api/projects/proj-1',
      '/api/agent/events',
      '/api/agent/tasks/t1/attachments/a1/content',
      // Reached by fire through conductor-sdk's backend client, not by the
      // daemon's own fetch calls. Omitting these makes a shared daemon look
      // healthy while its fires 401 partway through a task.
      '/api/tasks/t1/group',
      '/api/tasks/t1/insert',
      '/api/tasks/t1/scheduled-messages',
      '/api/tasks/t1/scheduled-messages/m1',
      '/api/tasks/t1/attachments/a1',
      '/api/issues/i1',
      // Collections included. `resolveDefaultProjectId` in fire calls
      // /api/projects, `conductor issue` inside a guest task calls /api/issues,
      // and `conductor diagnose` calls /api/diagnostics. Denying these made a
      // guest strictly less capable than an ordinary daemon for no security
      // gain -- escalation is stopped by row scoping, not by hiding lists.
      '/api/projects',
      '/api/issues',
      '/api/diagnostics/tasks/t1',
      // A guest may share its own task's transcript, same as any daemon. The
      // task must still live on the guest host (row scoping), and the owner can
      // already read that transcript off their own disk.
      '/api/tasks/t1/share',
      // Normalization still has to hold for the paths that ARE checked.
      '/api/tasks//t1/messages',
      '/api/TASKS/t1/messages',
      // Driving your own machine is what a daemon is for. Advertising
      // `remote_exec` while 401ing the route that invokes it was incoherent.
      // Which host it may drive is pinned below, not here.
      '/api/agents/shared-alice-alice-mbp/exec',
      '/api/agents/shared-alice-alice-mbp/restart',
    ]) {
      expect(isPathAllowedForDaemonShare(normalizeSharePath(path)!), path).toBe(true);
    }
  });

  it('refuses everything else, including the share endpoints themselves', () => {
    for (const path of [
      // The important one: a guest daemon asking "what should I run?" would be
      // handed its siblings' plaintext credentials.
      '/api/daemon-shares/mine',
      '/api/daemon-shares',
      '/api/auth/tokens/latest',
      '/api/auth/config',
      '/api/ai-manager/switch',
      '/api/subscription',
    ]) {
      expect(isPathAllowedForDaemonShare(normalizeSharePath(path)!), path).toBe(false);
    }
  });
});

describe('isDaemonShareUser', () => {
  it('treats absent scope as full', () => {
    // Every credential minted before sharing shipped has no scope, and every
    // AuthUser literal in existing tests omits it.
    expect(isDaemonShareUser({ tokenScope: undefined })).toBe(false);
    expect(isDaemonShareUser({ tokenScope: 'full' })).toBe(false);
    expect(isDaemonShareUser({ tokenScope: 'daemon_share' })).toBe(true);
  });
});

describe('resolveActiveShareForToken', () => {
  const token = 'abcdefgh0000000000';

  it('resolves the binding for an active share', async () => {
    mockDb.userToken.findMany.mockResolvedValue([
      { id: 'tok-1', userId: 'user-b', daemonShareId: 'share-1' },
    ]);
    mockDb.daemonShare.findFirst.mockResolvedValue({
      id: 'share-1',
      guestHost: 'shared-alice-mbp',
      granteeUserId: 'user-b',
    });

    await expect(resolveActiveShareForToken(token)).resolves.toEqual({
      shareId: 'share-1',
      guestHost: 'shared-alice-mbp',
      granteeUserId: 'user-b',
    });
    expect(mockDb.userToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ scope: 'daemon_share', revokedAt: null }),
      }),
    );
  });

  it('fails closed when the share is no longer active', async () => {
    // Revocation writes the share row and the token row separately; a request
    // landing between them must not be honoured.
    mockDb.userToken.findMany.mockResolvedValue([
      { id: 'tok-1', userId: 'user-b', daemonShareId: 'share-1' },
    ]);
    mockDb.daemonShare.findFirst.mockResolvedValue(null);

    await expect(resolveActiveShareForToken(token)).resolves.toBeNull();
  });

  it('fails closed when the token has no share attached', async () => {
    mockDb.userToken.findMany.mockResolvedValue([
      { id: 'tok-1', userId: 'user-b', daemonShareId: null },
    ]);
    await expect(resolveActiveShareForToken(token)).resolves.toBeNull();
    expect(mockDb.daemonShare.findFirst).not.toHaveBeenCalled();
  });
});

describe('isShareHostAllowed', () => {
  const binding = {
    shareId: 's1',
    guestHost: 'shared-alice-alice-mbp',
    granteeUserId: 'user-b',
  };

  it('rejects the grantee\'s own unrelated daemon', () => {
    // The attack this blocks: the owner holds this token on their own disk and
    // claims to be the grantee's personal laptop. Duplicate-host takeover would
    // then evict the grantee's real daemon and hand its tasks over.
    expect(isShareHostAllowed(binding, 'bob-macbook')).toBe(false);
  });

  it('accepts the guest host and its fire hosts', () => {
    expect(isShareHostAllowed(binding, 'shared-alice-alice-mbp')).toBe(true);
    expect(
      isShareHostAllowed(binding, 'conductor-fire-shared-alice-alice-mbp-task-9'),
    ).toBe(true);
  });
});


describe('isResourceInShareScope', () => {
  const binding = {
    shareId: 's1',
    guestHost: 'shared-alice-alice-mbp',
    granteeUserId: 'user-b',
  };

  it('refuses starting a task in a project bound to another of the grantee\'s daemons', async () => {
    // The escalation this closes: the credential lives on the machine OWNER's
    // disk. Without row scoping the owner could POST /api/tasks against a
    // project bound to the grantee's personal laptop, and an AI task is an
    // arbitrary prompt handed to a CLI with shell access -- code execution on
    // the grantee's own machine.
    mockDb.project.findFirst.mockResolvedValue(null);
    await expect(
      isResourceInShareScope(binding, '/api/tasks', { projectId: 'proj-on-laptop' }),
    ).resolves.toBe(false);
    expect(mockDb.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ daemonHost: 'shared-alice-alice-mbp' }),
      }),
    );
  });

  it('refuses a task create with no project rather than letting the backend pick a host', async () => {
    await expect(isResourceInShareScope(binding, '/api/tasks', {})).resolves.toBe(false);
  });

  it('refuses an explicit agent_host pointing at another daemon', async () => {
    mockDb.project.findFirst.mockResolvedValue({ id: 'p1' });
    await expect(
      isResourceInShareScope(binding, '/api/tasks', {
        projectId: 'p1',
        agent_host: 'bob-macbook',
      }),
    ).resolves.toBe(false);
  });

  it('allows a task create on the guest host', async () => {
    mockDb.project.findFirst.mockResolvedValue({ id: 'p1' });
    await expect(
      isResourceInShareScope(binding, '/api/tasks', { projectId: 'p1' }),
    ).resolves.toBe(true);
  });

  it('scopes task, project and issue reads to the guest host', async () => {
    mockDb.task.findFirst.mockResolvedValue(null);
    await expect(isResourceInShareScope(binding, '/api/tasks/t1', null)).resolves.toBe(false);

    mockDb.task.findFirst.mockResolvedValue({ id: 't1' });
    await expect(
      isResourceInShareScope(binding, '/api/tasks/t1/messages', null),
    ).resolves.toBe(true);

    mockDb.project.findFirst.mockResolvedValue(null);
    await expect(isResourceInShareScope(binding, '/api/projects/p9', null)).resolves.toBe(
      false,
    );

    mockDb.issue.findFirst.mockResolvedValue(null);
    await expect(isResourceInShareScope(binding, '/api/issues/i9', null)).resolves.toBe(
      false,
    );
  });

  it('refuses PATCH /api/tasks/:id that redirects to another daemon', async () => {
    // Round 1 fixed POST /api/tasks and left the identical escalation open
    // through PATCH: `agent_host` plus a `launch_config` whose command/args are
    // dispatched verbatim to a pty task on the named host. The task itself
    // legitimately lives on the guest host, so the path check alone passes.
    mockDb.task.findFirst.mockResolvedValue({ id: 't1' });
    await expect(
      isResourceInShareScope(binding, '/api/tasks/t1', {
        task_type: 'pty_task',
        agent_host: 'bob-macbook',
        launch_config: { command: 'sh', args: ['-c', 'id'] },
      }),
    ).resolves.toBe(false);
  });

  it('refuses a restart that relocates the task via target_daemon_host', async () => {
    // `target_daemon_host` additionally disables the project-binding guard, so
    // nothing downstream would catch the mismatch.
    mockDb.task.findFirst.mockResolvedValue({ id: 't1' });
    await expect(
      isResourceInShareScope(binding, '/api/tasks/t1/restart', {
        target_daemon_host: 'bob-macbook',
      }),
    ).resolves.toBe(false);
  });

  it('still allows a PATCH that names this share\'s own host', async () => {
    mockDb.task.findFirst.mockResolvedValue({ id: 't1' });
    await expect(
      isResourceInShareScope(binding, '/api/tasks/t1', {
        agent_host: 'shared-alice-alice-mbp',
      }),
    ).resolves.toBe(true);
  });

  it('allows reading the task collection', async () => {
    // A GET has no destination to redirect. Refusing it 401s every `list_tasks`
    // the AI makes inside a shared task -- the "healthy daemon, 401ing fires"
    // failure mode.
    await expect(isResourceInShareScope(binding, '/api/tasks', null)).resolves.toBe(true);
    await expect(
      isResourceInShareScope(binding, '/api/tasks/achieved', null),
    ).resolves.toBe(true);
  });

  it('pins per-daemon control routes to this share\'s own host', async () => {
    // The capability is restored, the target is not: exec/restart against
    // another of the grantee's machines is the escalation this whole layer
    // exists to stop.
    await expect(
      isResourceInShareScope(binding, '/api/agents/bob-macbook/exec', null),
    ).resolves.toBe(false);
    await expect(
      isResourceInShareScope(binding, '/api/agents/shared-alice-alice-mbp/exec', null),
    ).resolves.toBe(true);
    // Path arrives lowercased from the shared normalizer; a guest host is not
    // necessarily lowercase, so the compare has to tolerate that.
    await expect(
      isResourceInShareScope(
        { ...binding, guestHost: 'Shared-Alice-MBP' },
        '/api/agents/shared-alice-mbp/restart',
        null,
      ),
    ).resolves.toBe(true);
  });

  it('lets host-pinned agent routes through without a resource lookup', async () => {
    vi.clearAllMocks();
    await expect(isResourceInShareScope(binding, '/api/agents', null)).resolves.toBe(true);
    await expect(
      isResourceInShareScope(binding, '/api/agent/events', null),
    ).resolves.toBe(true);
    expect(mockDb.task.findFirst).not.toHaveBeenCalled();
  });
});


describe('normalizeSharePath', () => {
  it('is the single string both layers agree on', () => {
    expect(normalizeSharePath('/api/tasks//abc')).toBe('/api/tasks/abc');
    expect(normalizeSharePath('/api/TASKS/abc')).toBe('/api/tasks/abc');
    expect(normalizeSharePath('/api/tasks/1/%73hare')).toBe('/api/tasks/1/share');
  });

  it('refuses a path it cannot decode instead of passing it through', () => {
    // An undecodable path is not a benign one; for an authorization decision
    // "cannot be understood" has to mean unusable.
    expect(normalizeSharePath('/api/tasks/%ZZ')).toBeNull();
  });
});

describe('isResourceInShareScope fails closed', () => {
  const binding = {
    shareId: 's1',
    guestHost: 'shared-alice-alice-mbp',
    granteeUserId: 'user-b',
  };

  it('refuses a wide-prefix path that matches no known resource shape', async () => {
    // These used to pass the allowlist (which normalized) and then match none
    // of the resource branches (which did not), landing on a `return true` that
    // skipped host scoping altogether.
    // `/api/projects/` and `/api/issues/` are the collections and legitimately
    // pass; what must fail closed is a path under a wide prefix that names no
    // resource this layer knows how to pin to a host.
    for (const path of ['/api/diagnostics/tasks/', '/api/diagnostics/other']) {
      await expect(isResourceInShareScope(binding, path, null)).resolves.toBe(false);
    }
  });

  it('refuses rebinding a project to another daemon via a nested field', async () => {
    // `PATCH /api/projects/:id` carries the target as `binding.daemonHost`, so
    // a flat scan of the body misses it.
    mockDb.project.findFirst.mockResolvedValue({ id: 'p1' });
    await expect(
      isResourceInShareScope(binding, '/api/projects/p1', {
        binding: { daemonHost: 'bob-macbook', workspacePath: '/x' },
      }),
    ).resolves.toBe(false);
  });

  it('allows a nested binding that names this share\'s own host', async () => {
    mockDb.project.findFirst.mockResolvedValue({ id: 'p1' });
    await expect(
      isResourceInShareScope(binding, '/api/projects/p1', {
        binding: { daemonHost: 'shared-alice-alice-mbp' },
      }),
    ).resolves.toBe(true);
  });
});
