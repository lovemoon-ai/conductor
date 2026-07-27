import { describe, expect, it } from 'vitest';
import type { Task } from '@/shared/types';
import {
  filterTasksByProject,
  resolveTaskDaemonHost,
  resolveTaskDisplayProjectId,
} from './task-filter';

const makeTask = (
  id: string,
  projectId: string | null,
  secondProjectId: string | null = null,
): Task => ({
  id,
  projectId,
  secondProjectId,
  issueId: null,
  title: id,
  taskType: 'ai_task',
  status: 'running',
  agentHost: null,
  executionHost: null,
  backendType: null,
  sessionId: null,
  sessionFilePath: null,
  launchConfig: null,
  metadata: null,
  lastUserMessage: null,
  lastAssistantMessage: null,
  ptySession: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: null,
});

describe('filterTasksByProject', () => {
  const tasks: Task[] = [
    makeTask('t1', 'proj-a'),
    makeTask('t2', 'proj-b'),
    makeTask('t3', 'proj-c'),
    makeTask('t4', null),
  ];

  it('returns every task (excluding hidden) when no project filter is supplied', () => {
    expect(filterTasksByProject(tasks, null).map((task) => task.id)).toEqual([
      't1',
      't2',
      't3',
      't4',
    ]);
  });

  it('matches a single projectId exactly', () => {
    expect(filterTasksByProject(tasks, 'proj-a').map((task) => task.id)).toEqual(['t1']);
  });

  it('matches any member id when given a cross-daemon merged project group', () => {
    expect(
      filterTasksByProject(tasks, ['proj-a', 'proj-b']).map((task) => task.id),
    ).toEqual(['t1', 't2']);
  });

  it('treats an empty array filter as "no filter"', () => {
    // Empty array means the caller has no selection — behave like null so the
    // full list (modulo hidden projects) renders.
    expect(filterTasksByProject(tasks, [], ['proj-c']).map((task) => task.id)).toEqual([
      't1',
      't2',
      't4',
    ]);
  });

  it('drops members from the merged scope that are hidden, keeping the rest', () => {
    expect(
      filterTasksByProject(tasks, ['proj-a', 'proj-b'], ['proj-a']).map((task) => task.id),
    ).toEqual(['t2']);
  });

  it('returns an empty list when every merged-scope member is hidden', () => {
    expect(
      filterTasksByProject(tasks, ['proj-a'], ['proj-a']),
    ).toEqual([]);
  });
});

describe('resolveTaskDisplayProjectId', () => {
  it('falls back to the real projectId when no secondProjectId is set', () => {
    expect(resolveTaskDisplayProjectId(makeTask('t', 'proj-a'))).toBe('proj-a');
  });

  it('prefers secondProjectId when present', () => {
    expect(resolveTaskDisplayProjectId(makeTask('t', 'default', 'proj-b'))).toBe('proj-b');
  });

  it('ignores blank secondProjectId', () => {
    expect(resolveTaskDisplayProjectId(makeTask('t', 'proj-a', '   '))).toBe('proj-a');
  });
});

describe('filterTasksByProject with display-only secondProjectId', () => {
  // A task whose real project is `default` but which was "moved" to `proj-b`.
  const movedTask = makeTask('moved', 'default', 'proj-b');
  const defaultTask = makeTask('stays', 'default');
  const tasks: Task[] = [movedTask, defaultTask, makeTask('native', 'proj-b')];

  it('shows a moved task under its target project, not its real one', () => {
    expect(filterTasksByProject(tasks, 'proj-b').map((t) => t.id)).toEqual([
      'moved',
      'native',
    ]);
  });

  it('excludes a moved task from its real (default) project view (mutual exclusion)', () => {
    expect(filterTasksByProject(tasks, 'default').map((t) => t.id)).toEqual(['stays']);
  });

  it('buckets a moved task under the target when hiding by display id', () => {
    // Hiding the target project hides the moved task even though its real
    // projectId is not hidden.
    expect(filterTasksByProject(tasks, null, ['proj-b']).map((t) => t.id)).toEqual([
      'stays',
    ]);
  });
});

describe('resolveTaskDaemonHost', () => {
  const baseTask = (overrides: Partial<Task>): Task => ({
    ...makeTask('t', 'proj-a'),
    ...overrides,
  });

  it('prefers task.metadata.daemonName — the only signal for Default Project tasks', () => {
    // The server-side Default Project has `daemonHost=null`, so the only
    // reliable signal for "which daemon does this task live on" is the
    // `daemonName` the daemon writes into task metadata at registration.
    const task = baseTask({
      projectId: 'default-project',
      metadata: { daemonName: 'qa-daemon-2' },
    });
    const map = new Map<string, string | null>([['default-project', null]]);
    expect(resolveTaskDaemonHost(task, map)).toBe('qa-daemon-2');
  });

  it('falls back to executionHost when metadata is missing', () => {
    const task = baseTask({ metadata: null, executionHost: 'fire-7' });
    expect(resolveTaskDaemonHost(task, null)).toBe('fire-7');
  });

  it('falls back to agentHost when metadata and executionHost are missing', () => {
    const task = baseTask({ metadata: null, executionHost: null, agentHost: 'daemon-a' });
    expect(resolveTaskDaemonHost(task, null)).toBe('daemon-a');
  });

  it('falls back to the project map when task-level fields are missing', () => {
    const task = baseTask({ projectId: 'proj-bound', metadata: null });
    const map = new Map<string, string | null>([['proj-bound', 'bound-daemon']]);
    expect(resolveTaskDaemonHost(task, map)).toBe('bound-daemon');
  });

  it('ignores blank metadata.daemonName and uses the next fallback', () => {
    const task = baseTask({ metadata: { daemonName: '   ' }, executionHost: 'fire-1' });
    expect(resolveTaskDaemonHost(task, null)).toBe('fire-1');
  });

  it('returns null when no signal is available', () => {
    const task = baseTask({ projectId: 'unknown', metadata: null });
    expect(resolveTaskDaemonHost(task, new Map())).toBeNull();
  });
});
