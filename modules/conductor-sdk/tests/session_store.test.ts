import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { SessionDiskStore } from '../src/session/index.js';

describe('SessionDiskStore', () => {
  test('creates lock directory for backend-scoped store before first load/upsert', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-session-store-'));
    const sessionFile = path.join(tempRoot, '.conductor', 'sessions', 'conductor-ai.top.yaml');
    const store = new SessionDiskStore(sessionFile);

    expect(store.load()).toEqual([]);
    expect(fs.existsSync(path.dirname(sessionFile))).toBe(true);

    store.upsert({
      projectId: 'proj-1',
      taskId: 'task-1',
      projectPath: '/tmp/project-1',
      sessionId: 'session-1',
      backendType: 'codex',
    });

    expect(fs.existsSync(sessionFile)).toBe(true);
  });
});
