import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();

vi.mock('../api/client', () => ({
  getApiClient: () => ({
    get: mockGet,
  }),
}));

import { useTasksStore } from './tasks';

describe('tasks store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTasksStore.setState({
      tasks: [],
      isLoading: false,
      error: null,
      currentProjectFilter: null,
      unreadTaskIds: new Set(),
    });
  });

  it('hydrates pty_session data from task list responses', async () => {
    mockGet.mockResolvedValueOnce([
      {
        id: 'task-pty-1',
        project_id: 'proj-1',
        title: 'Persisted PTY',
        task_type: 'pty_task',
        status: 'killed',
        pty_session: {
          id: 'pty-1',
          task_id: 'task-pty-1',
          state: 'exited',
          pid: 4321,
          cwd: '/tmp/worktree',
          shell: '/bin/zsh',
          last_output_seq: 27,
        },
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
    ]);

    await useTasksStore.getState().fetchTasks();

    expect(mockGet).toHaveBeenCalledWith('/tasks?recover_stale=1');

    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-pty-1',
      taskType: 'pty_task',
      status: 'killed',
      ptySession: {
        id: 'pty-1',
        state: 'exited',
        pid: 4321,
        cwd: '/tmp/worktree',
        lastOutputSeq: 27,
      },
    });
  });

  it('fetches task detail and upserts persisted pty_session data', async () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-pty-2',
          projectId: 'proj-1',
          title: 'Old PTY',
          taskType: 'pty_task',
          status: 'unknown',
          ptySession: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });
    mockGet.mockResolvedValueOnce({
      id: 'task-pty-2',
      project_id: 'proj-1',
      title: 'Old PTY',
      task_type: 'pty_task',
      status: 'completed',
      pty_session: {
        id: 'pty-2',
        task_id: 'task-pty-2',
        state: 'exited',
        pid: 7654,
        cwd: '/tmp/detail-worktree',
        shell: '/bin/bash',
        last_output_seq: 88,
      },
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:02:00.000Z',
    });

    const task = await useTasksStore.getState().fetchTask('task-pty-2');

    expect(mockGet).toHaveBeenCalledWith('/tasks/task-pty-2?recover_stale=1');
    expect(task).toMatchObject({
      id: 'task-pty-2',
      status: 'completed',
      ptySession: {
        id: 'pty-2',
        state: 'exited',
        pid: 7654,
        cwd: '/tmp/detail-worktree',
        lastOutputSeq: 88,
      },
    });
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-pty-2',
      status: 'completed',
      ptySession: {
        id: 'pty-2',
        pid: 7654,
      },
    });
  });

  it('moves an updated task to the front when requested', () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'First task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'task-2',
          title: 'Second task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2024-01-01T00:01:00.000Z',
          updatedAt: '2024-01-01T00:01:00.000Z',
        },
      ],
    });

    useTasksStore.getState().updateTaskInList(
      {
        id: 'task-2',
        title: 'Second task updated',
        taskType: 'ai_task',
        status: 'completed',
        createdAt: '2024-01-01T00:01:00.000Z',
        updatedAt: '2024-01-01T00:02:00.000Z',
      },
      { moveToFront: true },
    );

    expect(useTasksStore.getState().tasks.map((task) => task.id)).toEqual(['task-2', 'task-1']);
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-2',
      title: 'Second task updated',
      status: 'completed',
      updatedAt: '2024-01-01T00:02:00.000Z',
    });
  });
});
