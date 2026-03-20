import { describe, expect, test } from 'vitest';

import { SessionManager } from '../src/session/index.js';

describe('SessionManager', () => {
  test('adds and retrieves session', async () => {
    const manager = new SessionManager();
    await manager.addSession('task1', 'sess1', 'proj1');
    const session = await manager.getSession('task1');
    expect(session?.sessionId).toBe('sess1');
  });

  test('message queue and ack', async () => {
    const manager = new SessionManager();
    await manager.addSession('task1', 'sess1', 'proj1');
    await manager.addMessage('task1', {
      messageId: 'msg1',
      role: 'user',
      content: 'hello',
      ackToken: 't1',
      metadata: { source: 'upload' },
      attachments: [{ id: 'att-1', name: 'diagram.png' }],
    });
    await manager.addMessage('task1', { messageId: 'msg2', role: 'user', content: 'world', ackToken: 't2' });
    const batch = await manager.popMessages('task1', 1);
    expect(batch).toHaveLength(1);
    expect(batch[0].messageId).toBe('msg1');
    expect(batch[0].metadata).toEqual({ source: 'upload' });
    expect(batch[0].attachments).toEqual([{ id: 'att-1', name: 'diagram.png' }]);
    expect(await manager.ack('task1', 't1')).toBe(true);
    expect(await manager.ack('task1', 'bad')).toBe(false);
  });

  test('lists sessions', async () => {
    const manager = new SessionManager();
    await manager.addSession('task1', 'sess1', 'proj1');
    await manager.addSession('task2', 'sess2', 'proj1');
    const sessions = await manager.listSessions();
    expect(new Set(sessions.map((s) => s.taskId))).toEqual(new Set(['task1', 'task2']));
  });
});
