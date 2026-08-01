import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { DownstreamInboxStore } from '../src/outbox/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('DownstreamInboxStore', () => {
  test('durably upserts, retries, and removes commands by request id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'downstream-inbox-'));
    roots.push(root);
    const store = DownstreamInboxStore.forProjectPath(root, 'agent:fire-1');
    const command = {
      requestId: 'req-1', taskId: 'task-1',
      cursor: { createdAt: '2026-08-01T00:00:00Z', requestId: 'req-1' },
      envelope: { type: 'task_user_message', payload: { task_id: 'task-1' } },
    };
    store.upsert(command);
    store.upsert(command);
    expect(store.list()).toHaveLength(1);
    store.markRetry('req-1', 1000);
    expect(store.list()[0].attemptCount).toBe(1);
    store.remove('req-1');
    expect(store.list()).toEqual([]);
  });

  test('fails closed when a persisted entry is malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'downstream-inbox-'));
    roots.push(root);
    const filePath = path.join(root, 'inbox.json');
    fs.writeFileSync(filePath, JSON.stringify({ entries: [{ requestId: 'accepted-but-corrupt' }] }));
    expect(() => new DownstreamInboxStore(filePath).list()).toThrow('Invalid downstream inbox entry');
  });
});
