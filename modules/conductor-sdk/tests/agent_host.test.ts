import { describe, expect, test } from 'vitest';

import { buildFireHostName } from '../src/agent-host.js';

const daemonEnv = {
  CONDUCTOR_DAEMON_NAME: 'mac-studio',
  CONDUCTOR_TASK_ID: 'task-1',
};

describe('buildFireHostName', () => {
  test('keeps the same identity when a task restarts under a new process', () => {
    // The server pins undelivered commands and signs attachment transfer tokens
    // against this string, so a restart must not orphan them.
    expect(buildFireHostName(daemonEnv, 111)).toBe(buildFireHostName(daemonEnv, 222));
  });

  test('gives concurrent fires on one daemon distinct identities', () => {
    // Same name would make the realtime hub evict the previously connected fire.
    const first = buildFireHostName({ ...daemonEnv, CONDUCTOR_TASK_ID: 'task-1' });
    const second = buildFireHostName({ ...daemonEnv, CONDUCTOR_TASK_ID: 'task-2' });
    expect(first).not.toBe(second);
  });

  test('never impersonates the daemon that spawned it', () => {
    // CONDUCTOR_DAEMON_NAME is inherited, so returning it verbatim would collide
    // with the daemon's own connection and drop the fire prefix.
    const host = buildFireHostName(daemonEnv);
    expect(host).not.toBe('mac-studio');
    expect(host.startsWith('conductor-fire-')).toBe(true);
  });

  test('keeps the prefix that selects the manual_fire plan bucket', () => {
    for (const env of [{}, { HOSTNAME: 'box' }, daemonEnv, { CONDUCTOR_TASK_ID: 'task-9' }]) {
      expect(buildFireHostName(env).startsWith('conductor-fire-')).toBe(true);
    }
  });

  test('falls back to a per-process name until the fire owns a task', () => {
    const host = buildFireHostName({ CONDUCTOR_DAEMON_NAME: 'mac-studio' }, 4242);
    expect(host).toBe('conductor-fire-mac-studio-pid-4242');
  });

  test('sanitizes segments that would break host matching', () => {
    const host = buildFireHostName({ CONDUCTOR_DAEMON_NAME: 'my box/01', CONDUCTOR_TASK_ID: 'task 1' });
    expect(host).toBe('conductor-fire-my-box-01-task-1');
  });

  test('prefers the daemon name over the machine hostname', () => {
    const host = buildFireHostName({ ...daemonEnv, HOSTNAME: 'raw-hostname' });
    expect(host).toBe('conductor-fire-mac-studio-task-1');
  });
});
