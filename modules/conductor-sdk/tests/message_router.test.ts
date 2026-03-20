import { describe, expect, test } from 'vitest';

import { MessageRouter } from '../src/message/index.js';
import { SessionManager } from '../src/session/index.js';

class FakeNotifier {
  public logs: string[] = [];
  async notifyNewMessage(taskId: string): Promise<void> {
    this.logs.push(taskId);
  }
}

describe('MessageRouter', () => {
  test('enqueues backend user messages', async () => {
    const sessions = new SessionManager();
    await sessions.addSession('task1', 'sess1', 'proj1');
    const router = new MessageRouter(sessions);
    await router.handleBackendEvent({
      type: 'task_user_message',
      payload: {
        task_id: 'task1',
        message_id: 'msg1',
        role: 'user',
        content: 'hello',
        ack_token: 'ack1',
      },
    });
    const messages = await sessions.popMessages('task1');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello');
  });

  test('preserves metadata and attachments on backend user messages', async () => {
    const sessions = new SessionManager();
    await sessions.addSession('task1', 'sess1', 'proj1');
    const router = new MessageRouter(sessions);

    await router.handleBackendEvent({
      type: 'task_user_message',
      payload: {
        task_id: 'task1',
        message_id: 'msg-attachment',
        role: 'user',
        content: 'Attached file: diagram.png',
        metadata: { source: 'upload' },
        attachments: [
          {
            id: 'att-1',
            name: 'diagram.png',
            mimeType: 'image/png',
            downloadUrl: '/api/tasks/task1/attachments/att-1',
          },
        ],
      },
    });

    const messages = await sessions.popMessages('task1');
    expect(messages).toHaveLength(1);
    expect(messages[0].metadata).toEqual({ source: 'upload' });
    expect(messages[0].attachments).toEqual([
      {
        id: 'att-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        downloadUrl: '/api/tasks/task1/attachments/att-1',
      },
    ]);
  });

  test('auto creates session when project provided', async () => {
    const sessions = new SessionManager();
    const router = new MessageRouter(sessions);
    await router.handleBackendEvent({
      type: 'task_user_message',
      payload: { task_id: 'taskX', project_id: 'projX', message_id: 'msg1', role: 'user', content: 'hi' },
    });
    const messages = await sessions.popMessages('taskX');
    expect(messages).toHaveLength(1);
  });

  test('formats task_action content', async () => {
    const sessions = new SessionManager();
    await sessions.addSession('task42', 'sess42', 'proj1');
    const router = new MessageRouter(sessions);
    await router.handleBackendEvent({
      type: 'task_action',
      payload: {
        task_id: 'task42',
        action: 'run_tests',
        args: { command: 'npm test' },
      },
    });
    const messages = await sessions.popMessages('task42');
    expect(messages[0].role).toBe('action');
    expect(messages[0].content).toContain('npm test');
  });

  test('invokes outbound handlers', async () => {
    const sessions = new SessionManager();
    const router = new MessageRouter(sessions);
    let called = false;
    router.registerOutboundHandler(async (payload) => {
      if (payload.type === 'sdk_message') {
        called = true;
      }
    });
    await router.sendToBackend({ type: 'sdk_message' });
    expect(called).toBe(true);
  });

  test('notifies MCP when new message arrives', async () => {
    const sessions = new SessionManager();
    await sessions.addSession('task1', 'sess1', 'proj1');
    const notifier = new FakeNotifier();
    const router = new MessageRouter(sessions, notifier as any);
    await router.handleBackendEvent({
      type: 'task_user_message',
      payload: { task_id: 'task1', message_id: 'msg1', content: 'hello' },
    });
    expect(notifier.logs).toEqual(['task1']);
  });
});
