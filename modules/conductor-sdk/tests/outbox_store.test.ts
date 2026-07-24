import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { DurableUpstreamOutboxStore } from '../src/outbox/index.js';

describe('DurableUpstreamOutboxStore', () => {
  test('upsert, markRetry, listReady and remove persist to disk', () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-outbox-project-'));
    const store = DurableUpstreamOutboxStore.forProjectPath(projectPath, 'task:task-1');

    const created = store.upsert({
      stableId: 'msg-1',
      eventType: 'sdk_message',
      payload: {
        taskId: 'task-1',
        content: 'hello',
        messageId: 'msg-1',
      },
    });

    expect(created.stableId).toBe('msg-1');
    expect(store.load()).toHaveLength(1);
    expect(store.listReady()).toHaveLength(1);

    const retried = store.markRetry('msg-1', 5_000);
    expect(retried?.attemptCount).toBe(1);
    expect(store.listReady(Date.now())).toHaveLength(0);
    expect(store.nextRetryDelay(Date.now())).not.toBeNull();

    store.remove('msg-1');
    expect(store.load()).toEqual([]);
  });

  describe('dropPendingTerminalStatusEvents', () => {
    const newStore = () =>
      DurableUpstreamOutboxStore.forProjectPath(
        fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-outbox-project-')),
        'task:task-1',
      );

    test('drops queued terminal statuses so a restart is not killed by the previous run', () => {
      const store = newStore();
      store.upsert({
        stableId: 'status-killed',
        eventType: 'task_status_update',
        payload: { task_id: 'task-1', status: 'KILLED', summary: 'stopped via tmux kill-session' },
      });

      const dropped = store.dropPendingTerminalStatusEvents();

      expect(dropped).toHaveLength(1);
      expect(dropped[0].stableId).toBe('status-killed');
      expect(store.load()).toEqual([]);
    });

    test('keeps sdk_message and ack entries, drops only terminal statuses', () => {
      const store = newStore();
      store.upsert({
        stableId: 'msg-1',
        eventType: 'sdk_message',
        payload: { taskId: 'task-1', content: 'real conversation content' },
      });
      store.upsert({
        stableId: 'stop-ack-1',
        eventType: 'task_stop_ack',
        payload: { task_id: 'task-1', request_id: 'req-1', accepted: true },
      });
      store.upsert({
        stableId: 'status-completed',
        eventType: 'task_status_update',
        payload: { task_id: 'task-1', status: 'COMPLETED' },
      });

      const dropped = store.dropPendingTerminalStatusEvents();

      expect(dropped.map((entry) => entry.stableId)).toEqual(['status-completed']);
      expect(store.load().map((entry) => entry.stableId).sort()).toEqual(['msg-1', 'stop-ack-1']);
    });

    test('keeps non-terminal status updates such as RUNNING', () => {
      const store = newStore();
      store.upsert({
        stableId: 'status-running',
        eventType: 'task_status_update',
        payload: { task_id: 'task-1', status: 'RUNNING' },
      });

      expect(store.dropPendingTerminalStatusEvents()).toEqual([]);
      expect(store.load()).toHaveLength(1);
    });

    test('matches terminal status case-insensitively and is a no-op on an empty outbox', () => {
      const store = newStore();
      expect(store.dropPendingTerminalStatusEvents()).toEqual([]);

      store.upsert({
        stableId: 'status-lower',
        eventType: 'task_status_update',
        payload: { task_id: 'task-1', status: 'killed' },
      });

      expect(store.dropPendingTerminalStatusEvents()).toHaveLength(1);
      expect(store.load()).toEqual([]);
    });
  });
});
