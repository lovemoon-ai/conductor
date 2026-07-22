import { describe, expect, it } from 'vitest';
import type { Task } from '@/shared/types';
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
});
