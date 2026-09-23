import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/shared/types';
import { buildTaskListNavigation } from './task-list-navigation';

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  projectId: 'project-1',
  title: id,
  taskType: 'ai_task',
  status: 'running',
  agentHost: null,
  executionHost: null,
  backendType: null,
  metadata: null,
  launchConfig: null,
  attachedTerminal: null,
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: null,
  ...overrides,
});

const makeProject = (
  id: string,
  name: string,
  daemonHost: string,
  metadata: Record<string, unknown> | null,
): Project => ({ id, name, daemonHost, metadata } as Project);

describe('buildTaskListNavigation', () => {
  it('emits only the selected task from a merged card at the card row position', () => {
    const result = buildTaskListNavigation(
      [makeTask('task-1'), makeTask('task-2'), makeTask('task-4'), makeTask('task-3')],
      [{
        id: 'group-1',
        taskIds: ['task-2', 'task-3'],
        activeIndex: 1,
        labels: {},
      }],
    );

    expect(result.tasks.map((task) => task.id)).toEqual(['task-1', 'task-3', 'task-4']);
    expect(result.activeTaskIdByTaskId.get('task-2')).toBe('task-3');
    expect(result.activeTaskIdByTaskId.get('task-3')).toBe('task-3');
  });

  it('matches list filters and hides a PTY task attached to an AI task', () => {
    const result = buildTaskListNavigation(
      [
        makeTask('ai-running', {
          backendType: 'codex',
          attachedTerminal: { id: 'attachment-1', ptyTaskId: 'pty-attached', ptyTaskStatus: 'running' },
        }),
        makeTask('pty-attached', { taskType: 'pty_task' }),
        makeTask('ai-killed', { status: 'killed', backendType: 'codex' }),
        makeTask('ai-other-backend', { backendType: 'claude' }),
      ],
      [],
      {
        projectFilter: 'project-1',
        runningOnly: true,
        taskTypeFilter: 'ai_task',
        backendFilter: 'codex',
      },
    );

    expect(result.tasks.map((task) => task.id)).toEqual(['ai-running']);
  });

  it('keeps persistent tasks in place and hides them for projects that turned them off', () => {
    const persistent = { persistent: { enabled: true } };
    const tasks = [
      makeTask('persistent-a', { metadata: persistent }),
      makeTask('normal-a'),
      makeTask('persistent-b', { projectId: 'project-2', metadata: persistent }),
      makeTask('pinned', { metadata: { ...persistent, pinnedAt: '2026-07-23T00:00:00.000Z' } }),
      makeTask('normal-b', { projectId: 'project-2' }),
    ];

    expect(buildTaskListNavigation(tasks, []).tasks.map((task) => task.id)).toEqual([
      'pinned',
      'persistent-a',
      'normal-a',
      'persistent-b',
      'normal-b',
    ]);

    const hidden = buildTaskListNavigation(tasks, [], {
      projects: [
        makeProject('project-1', 'app', 'daemon-a', null),
        makeProject('project-2', 'site', 'daemon-a', { showPersistentTasks: false }),
      ],
    });
    expect(hidden.tasks.map((task) => task.id)).toEqual(['pinned', 'persistent-a', 'normal-a', 'normal-b']);
  });

  it('hides persistent tasks across a merged project when any member turned them off', () => {
    const persistent = { persistent: { enabled: true } };
    const result = buildTaskListNavigation(
      [
        makeTask('on-daemon-a', { projectId: 'project-a', metadata: persistent }),
        makeTask('on-daemon-b', { projectId: 'project-b', metadata: persistent }),
      ],
      [],
      {
        projects: [
          makeProject('project-a', 'app', 'daemon-a', { showPersistentTasks: false }),
          // Joined later: no setting of its own yet.
          makeProject('project-b', 'app', 'daemon-b', null),
        ],
      },
    );
    expect(result.tasks).toEqual([]);
  });
});

