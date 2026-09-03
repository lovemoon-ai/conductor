import { describe, it, expect } from 'vitest';
import { ApiRequestError } from '@/shared/api/client';
import {
  ACTIVE_SESSION_WINDOW_MS,
  defaultResumeTaskTitle,
  formatRelativeTime,
  getPathTail,
  getSessionsErrorMessage,
  isSessionActive,
  normalizeDaemonSession,
  sessionDisplayTitle,
  sortSessionsForDisplay,
  type DaemonSessionSummary,
} from './resume-sessions';

const NOW = Date.parse('2026-09-02T12:00:00Z');

const makeSession = (overrides: Partial<DaemonSessionSummary>): DaemonSessionSummary => ({
  backend: 'claude',
  sessionId: 'session-1',
  sessionFilePath: null,
  cwd: null,
  title: null,
  updatedAt: null,
  linkedTaskId: null,
  projectId: null,
  ...overrides,
});

describe('normalizeDaemonSession', () => {
  it('accepts the snake_case API contract shape', () => {
    expect(
      normalizeDaemonSession({
        backend: 'codex',
        session_id: 'abc',
        session_file_path: '/tmp/abc.jsonl',
        cwd: '/home/me/repo',
        title: 'Fix the build',
        updated_at: '2026-09-02T11:00:00Z',
        linked_task_id: 'task-1',
        project_id: 'project-1',
      }),
    ).toEqual({
      backend: 'codex',
      sessionId: 'abc',
      sessionFilePath: '/tmp/abc.jsonl',
      cwd: '/home/me/repo',
      title: 'Fix the build',
      updatedAt: '2026-09-02T11:00:00Z',
      linkedTaskId: 'task-1',
      projectId: 'project-1',
    });
  });

  it('drops entries without backend or session id', () => {
    expect(normalizeDaemonSession({ backend: 'claude' })).toBeNull();
    expect(normalizeDaemonSession({ session_id: 'abc' })).toBeNull();
    expect(normalizeDaemonSession(null)).toBeNull();
  });
});

describe('getPathTail / sessionDisplayTitle', () => {
  it('returns the last path segment, tolerating trailing slashes', () => {
    expect(getPathTail('/home/me/repo')).toBe('repo');
    expect(getPathTail('/home/me/repo/')).toBe('repo');
    expect(getPathTail(null)).toBe('');
  });

  it('prefers title, then cwd tail, then a short id', () => {
    expect(sessionDisplayTitle(makeSession({ title: 'Hello', cwd: '/a/b' }))).toBe('Hello');
    expect(sessionDisplayTitle(makeSession({ cwd: '/a/b' }))).toBe('b');
    expect(sessionDisplayTitle(makeSession({ sessionId: 'abcdefgh-rest' }))).toBe('abcdefgh');
  });
});

describe('defaultResumeTaskTitle', () => {
  it('truncates long session titles', () => {
    const title = 'x'.repeat(80);
    expect(defaultResumeTaskTitle(makeSession({ title }))).toBe(`${'x'.repeat(60)}…`);
  });

  it('falls back to Resume: <cwd tail>', () => {
    expect(defaultResumeTaskTitle(makeSession({ cwd: '/home/me/repo' }))).toBe('Resume: repo');
  });
});

describe('isSessionActive', () => {
  it('marks sessions updated under 2 minutes ago as active', () => {
    expect(isSessionActive(new Date(NOW - 60_000).toISOString(), NOW)).toBe(true);
    expect(isSessionActive(new Date(NOW - ACTIVE_SESSION_WINDOW_MS).toISOString(), NOW)).toBe(false);
    expect(isSessionActive(null, NOW)).toBe(false);
    expect(isSessionActive('not-a-date', NOW)).toBe(false);
  });
});

describe('formatRelativeTime', () => {
  it('formats minute/hour/day buckets', () => {
    expect(formatRelativeTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now');
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago');
    expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago');
    expect(formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d ago');
    expect(formatRelativeTime(null, NOW)).toBe('');
  });
});

describe('sortSessionsForDisplay', () => {
  it('sinks linked sessions and sorts each half by recency', () => {
    const linkedNew = makeSession({
      sessionId: 'linked-new',
      linkedTaskId: 'task-1',
      updatedAt: '2026-09-02T11:59:00Z',
    });
    const unlinkedOld = makeSession({ sessionId: 'old', updatedAt: '2026-09-01T00:00:00Z' });
    const unlinkedNew = makeSession({ sessionId: 'new', updatedAt: '2026-09-02T11:00:00Z' });
    const unlinkedNoTime = makeSession({ sessionId: 'no-time' });

    const sorted = sortSessionsForDisplay([linkedNew, unlinkedNoTime, unlinkedOld, unlinkedNew]);
    expect(sorted.map((session) => session.sessionId)).toEqual([
      'new',
      'old',
      'no-time',
      'linked-new',
    ]);
  });
});

describe('getSessionsErrorMessage', () => {
  it('maps daemon_offline, capability, and timeout errors', () => {
    expect(
      getSessionsErrorMessage(new ApiRequestError(404, { error: 'daemon_offline' })),
    ).toContain('offline');
    expect(
      getSessionsErrorMessage(new ApiRequestError(409, { error: 'daemon_capability_missing' })),
    ).toContain('Daemon version is outdated');
    expect(
      getSessionsErrorMessage(new ApiRequestError(504, { error: 'daemon_timeout' })),
    ).toContain('timed out');
  });

  it('falls back to payload or generic messages', () => {
    expect(getSessionsErrorMessage(new ApiRequestError(500, { error: 'boom' }))).toBe('boom');
    expect(getSessionsErrorMessage(new Error('network down'))).toBe('network down');
    expect(getSessionsErrorMessage('weird')).toBe('Failed to load sessions.');
  });
});
