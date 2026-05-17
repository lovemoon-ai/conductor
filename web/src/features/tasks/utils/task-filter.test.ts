import { describe, expect, it } from 'vitest';
import type { Task } from '@/shared/types';
import { filterTasksByProject } from './task-filter';

const makeTask = (id: string, projectId: string | null): Task => ({
  id,
  projectId,
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
