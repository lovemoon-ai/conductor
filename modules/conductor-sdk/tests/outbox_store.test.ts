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
});
