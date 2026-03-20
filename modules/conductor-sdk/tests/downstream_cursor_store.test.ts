import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { DownstreamCursorStore } from '../src/outbox/index.js';

describe('DownstreamCursorStore', () => {
  test('persists and compares agent cursor by host', () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-cursor-project-'));
    const store = DownstreamCursorStore.forProjectPath(projectPath, 'task:task-1');

    expect(store.get('conductor-fire-test')).toBeNull();

    store.advance('conductor-fire-test', {
      createdAt: '2026-03-10T10:00:00.000Z',
      requestId: 'cmd-1',
    });

    expect(store.hasApplied('conductor-fire-test', {
      createdAt: '2026-03-10T10:00:00.000Z',
      requestId: 'cmd-1',
    })).toBe(true);
    expect(store.hasApplied('conductor-fire-test', {
      createdAt: '2026-03-10T10:00:01.000Z',
      requestId: 'cmd-2',
    })).toBe(false);

    const reloaded = DownstreamCursorStore.forProjectPath(projectPath, 'task:task-1');
    expect(reloaded.get('conductor-fire-test')).toEqual({
      createdAt: '2026-03-10T10:00:00.000Z',
      requestId: 'cmd-1',
    });
  });
});
