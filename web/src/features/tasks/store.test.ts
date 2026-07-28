import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    delete: mockDelete,
  }),
}));

import { useTasksStore } from './store';
import { useTaskCardGroupsSyncStore } from './task-card-groups-sync-store';

describe('tasks store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskCardGroupsSyncStore.getState().reset();
    useTasksStore.setState({
      tasks: [],
      isLoading: false,
      error: null,
      currentProjectFilter: null,
      currentProjectIds: [],
      unreadTaskIds: new Set(),
    });
  });

  it("uses the extended task-mutation timeout for archive and delete", async () => {
    mockPost.mockResolvedValueOnce({});
    mockDelete.mockResolvedValueOnce(undefined);
    useTasksStore.setState({
      tasks: [
        {
          id: "task-1",
          title: "Task",
          status: "completed",
          taskType: "ai_task",
        },
      ],
    });

    await useTasksStore.getState().achieveTask("task-1");
    expect(mockPost).toHaveBeenCalledWith(
      "/tasks/task-1/achieve",
      {},
      { timeoutMs: 60_000 },
    );

    useTasksStore.setState({
      tasks: [
        {
          id: "task-2",
          title: "Task 2",
          status: "completed",
          taskType: "ai_task",
        },
      ],
    });
    await useTasksStore.getState().deleteTask("task-2");
    expect(mockDelete).toHaveBeenCalledWith(
      "/tasks/task-2",
      { timeoutMs: 60_000 },
    );
  });

  it('restarts a task and moves the returned task to the front', async () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Old task',
          taskType: 'ai_task',
          status: 'killed',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'task-2',
          title: 'Another task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2024-01-01T00:01:00.000Z',
          updatedAt: '2024-01-01T00:01:00.000Z',
        },
      ],
    });
    mockPost.mockResolvedValueOnce({
      mode: 'backend_switch_new_task',
      source_task_id: 'task-1',
      task: {
        id: 'task-3',
        title: 'Old task [claude]',
        task_type: 'ai_task',
        status: 'init',
        backend_type: 'claude',
        created_at: '2024-01-01T00:02:00.000Z',
        updated_at: '2024-01-01T00:02:00.000Z',
      },
      task_card_groups_snapshot: {
        version: 1,
        revision: 1,
        scopes: {
          'projects:all': [{
            id: 'branch-group',
            taskIds: ['task-1', 'task-3'],
            labels: {},
          }],
        },
      },
    });

    const result = await useTasksStore.getState().restartTask('task-1', {
      backendType: 'claude',
      strategy: 'new_task',
    });

    expect(mockPost).toHaveBeenCalledWith('/tasks/task-1/restart', {
      backend_type: 'claude',
      strategy: 'new_task',
    });
    expect(result).toMatchObject({
      mode: 'backend_switch_new_task',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-3',
        title: 'Old task [claude]',
        backendType: 'claude',
      },
    });
    expect(useTasksStore.getState().tasks.map((task) => task.id)).toEqual(['task-3', 'task-1', 'task-2']);
    expect(useTaskCardGroupsSyncStore.getState().snapshot).toEqual({
      version: 1,
      revision: 1,
      scopes: {
        'projects:all': [{
          id: 'branch-group',
          taskIds: ['task-1', 'task-3'],
          labels: {},
        }],
      },
    });
  });

  it('does not downgrade a newer running task back to init when restart response arrives late', async () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-3',
          title: 'Old task [claude]',
          taskType: 'ai_task',
          status: 'running',
          backendType: 'claude',
          sessionId: 'sess-3',
          createdAt: '2024-01-01T00:02:00.000Z',
          updatedAt: '2024-01-01T00:03:00.000Z',
        },
      ],
    });
    mockPost.mockResolvedValueOnce({
      mode: 'backend_switch_new_task',
      source_task_id: 'task-1',
      task: {
        id: 'task-3',
        title: 'Old task [claude]',
        task_type: 'ai_task',
        status: 'init',
        backend_type: 'claude',
        session_id: null,
        created_at: '2024-01-01T00:02:00.000Z',
        updated_at: '2024-01-01T00:02:30.000Z',
      },
    });

    const result = await useTasksStore.getState().restartTask('task-1', {
      backendType: 'claude',
      strategy: 'new_task',
    });

    expect(result.task).toMatchObject({
      id: 'task-3',
      status: 'running',
      sessionId: 'sess-3',
    });
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-3',
      status: 'running',
      sessionId: 'sess-3',
    });
  });

  it('updates the same task to running for in-place restart', async () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Restartable task',
          taskType: 'ai_task',
          status: 'completed',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'task-2',
          title: 'Another task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2024-01-01T00:01:00.000Z',
          updatedAt: '2024-01-01T00:01:00.000Z',
        },
      ],
    });
    mockPost.mockResolvedValueOnce({
      mode: 'inplace_restart',
      source_task_id: 'task-1',
      task: {
        id: 'task-1',
        title: 'Restartable task',
        task_type: 'ai_task',
        status: 'running',
        backend_type: 'codex',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:02:00.000Z',
      },
    });

    const result = await useTasksStore.getState().restartTask('task-1', {
      strategy: 'inplace',
    });

    expect(mockPost).toHaveBeenCalledWith('/tasks/task-1/restart', {
      strategy: 'inplace',
    });
    expect(result).toMatchObject({
      mode: 'inplace_restart',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-1',
        status: 'running',
      },
    });
    expect(useTasksStore.getState().tasks.map((task) => task.id)).toEqual(['task-1', 'task-2']);
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-1',
      status: 'running',
      updatedAt: '2024-01-01T00:02:00.000Z',
    });
  });

  it('refreshes an existing task session through restart mode and syncs returned metadata', async () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Refreshable task',
          taskType: 'ai_task',
          status: 'running',
          agentHost: 'old-daemon',
          executionHost: 'old-daemon',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });
    mockPost.mockResolvedValueOnce({
      mode: 'inplace_restart',
      source_task_id: 'task-1',
      task: {
        id: 'task-1',
        title: 'Refreshable task',
        task_type: 'ai_task',
        status: 'running',
        agent_host: 'new-daemon',
        execution_host: 'new-daemon',
        backend_type: 'codex',
        session_id: 'sess-1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:03:00.000Z',
      },
    });

    const result = await useTasksStore.getState().restartTask('task-1', {
      restartMode: 'refresh_session',
    });

    expect(mockPost).toHaveBeenCalledWith('/tasks/task-1/restart', {
      restart_mode: 'refresh_session',
    });
    expect(result.task).toMatchObject({
      id: 'task-1',
      status: 'running',
      agentHost: 'new-daemon',
      executionHost: 'new-daemon',
      sessionId: 'sess-1',
    });
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-1',
      agentHost: 'new-daemon',
      executionHost: 'new-daemon',
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

  it('fetchTask upserts attachedTerminal even when a project filter is active (regression: pty chip not appearing after attach until manual refresh)', async () => {
    // Reproduces the bug where TaskItem.handleAttachTerminal called
    // `fetchTasks(undefined)` after POST /tasks/:id/terminal. The tasks page
    // sets `currentProjectFilter` from the URL, so `requestedProjectId=null`
    // never matched and the response was silently dropped — the new
    // `attachedTerminal` field stayed invisible until the user reloaded.
    // The fix swaps that call for `fetchTask(taskId)`, which sidesteps the
    // filter guard entirely because it goes through `syncTask` / `upsertTask`.
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-ai-1',
          projectId: 'proj-1',
          title: 'AI Task',
          taskType: 'ai_task',
          status: 'running',
          attachedTerminal: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      currentProjectFilter: 'proj-1',
    });
    mockGet.mockResolvedValueOnce({
      id: 'task-ai-1',
      project_id: 'proj-1',
      title: 'AI Task',
      task_type: 'ai_task',
      status: 'running',
      attached_terminal: {
        id: 'attached-1',
        pty_task_id: 'pty-1',
        pty_task_status: 'running',
      },
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:01:00.000Z',
    });

    await useTasksStore.getState().fetchTask('task-ai-1');

    expect(mockGet).toHaveBeenCalledWith('/tasks/task-ai-1?recover_stale=1');
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-ai-1',
      attachedTerminal: {
        id: 'attached-1',
        ptyTaskId: 'pty-1',
        ptyTaskStatus: 'running',
      },
    });
    // The project filter must remain intact — `fetchTask` should not touch
    // the scope state.
    expect(useTasksStore.getState().currentProjectFilter).toBe('proj-1');
  });

  it('orders fetched pinned tasks before unpinned tasks by pin time', async () => {
    mockGet.mockResolvedValueOnce([
      {
        id: 'task-unpinned-new',
        project_id: 'proj-1',
        title: 'Unpinned New',
        task_type: 'ai_task',
        status: 'running',
        metadata: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:03:00.000Z',
      },
      {
        id: 'task-pinned-old',
        project_id: 'proj-1',
        title: 'Pinned Old',
        task_type: 'ai_task',
        status: 'running',
        metadata: { pinnedAt: '2024-01-01T00:00:00.000Z' },
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
      {
        id: 'task-pinned-new',
        project_id: 'proj-1',
        title: 'Pinned New',
        task_type: 'ai_task',
        status: 'running',
        metadata: { pinnedAt: '2024-01-02T00:00:00.000Z' },
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:02:00.000Z',
      },
    ]);

    await useTasksStore.getState().fetchTasks();

    expect(useTasksStore.getState().tasks.map((task) => task.id)).toEqual([
      'task-pinned-new',
      'task-pinned-old',
      'task-unpinned-new',
    ]);
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

  it('removes a task worktree and keeps the normalized task in the store', async () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-1',
          issueId: 'issue-1',
          title: 'Worktree task',
          taskType: 'ai_task',
          status: 'completed',
          launchConfig: {
            worktree: true,
            worktreeBranch: 'conductor/task/task-1',
          },
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });
    mockPost.mockResolvedValueOnce({
      task: {
        id: 'task-1',
        issue_id: 'issue-1',
        title: 'Worktree task',
        task_type: 'ai_task',
        status: 'completed',
        launch_config: {
          worktree: true,
          worktreeBranch: 'conductor/task/task-1',
        },
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
      cleaned_at: '2024-01-01T00:05:00.000Z',
      removed_path: '/tmp/worktrees/task-1',
      worktree_branch: 'conductor/task/task-1',
    });

    const result = await useTasksStore.getState().cleanupTaskWorktree('task-1');

    expect(mockPost).toHaveBeenCalledWith('/tasks/task-1/worktree');
    expect(result).toMatchObject({
      cleanedAt: '2024-01-01T00:05:00.000Z',
      removedPath: '/tmp/worktrees/task-1',
      worktreeBranch: 'conductor/task/task-1',
      task: {
        id: 'task-1',
        issueId: 'issue-1',
        updatedAt: '2024-01-01T00:01:00.000Z',
      },
    });
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-1',
      issueId: 'issue-1',
      updatedAt: '2024-01-01T00:01:00.000Z',
    });
  });

  it('ignores stale unfiltered fetch results after switching to a project filter', async () => {
    let resolveUnfiltered: ((value: unknown) => void) | null = null;
    let resolveFiltered: ((value: unknown) => void) | null = null;

    mockGet.mockImplementation((url: string) => {
      if (url === '/tasks?recover_stale=1') {
        return new Promise((resolve) => {
          resolveUnfiltered = resolve;
        });
      }
      if (url === '/tasks?project_id=proj-1&recover_stale=1') {
        return new Promise((resolve) => {
          resolveFiltered = resolve;
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const initialFetch = useTasksStore.getState().fetchTasks();
    useTasksStore.getState().setProjectFilter('proj-1');

    resolveFiltered?.([
      {
        id: 'task-proj-1',
        project_id: 'proj-1',
        title: 'Filtered task',
        task_type: 'ai_task',
        status: 'running',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(useTasksStore.getState().tasks).toMatchObject([
      {
        id: 'task-proj-1',
        projectId: 'proj-1',
      },
    ]);

    resolveUnfiltered?.([
      {
        id: 'task-all-1',
        project_id: 'proj-2',
        title: 'Unfiltered task',
        task_type: 'ai_task',
        status: 'running',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
    ]);
    await initialFetch;

    expect(useTasksStore.getState().tasks).toMatchObject([
      {
        id: 'task-proj-1',
        projectId: 'proj-1',
      },
    ]);
    expect(useTasksStore.getState().currentProjectFilter).toBe('proj-1');
  });

  it('fetches tasks across multiple projects via project_ids for cross-daemon merged groups', async () => {
    mockGet.mockResolvedValueOnce([
      {
        id: 'task-a',
        project_id: 'proj-a',
        title: 'A task',
        task_type: 'ai_task',
        status: 'running',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
      {
        id: 'task-b',
        project_id: 'proj-b',
        title: 'B task',
        task_type: 'ai_task',
        status: 'running',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
    ]);

    await useTasksStore.getState().fetchTasksForProjects(['proj-a', 'proj-b']);

    expect(mockGet).toHaveBeenCalledWith('/tasks?project_ids=proj-a%2Cproj-b&recover_stale=1');
    expect(useTasksStore.getState().currentProjectFilter).toBeNull();
    expect(useTasksStore.getState().currentProjectIds).toEqual(['proj-a', 'proj-b']);
    expect(useTasksStore.getState().tasks).toMatchObject([
      { id: 'task-a', projectId: 'proj-a' },
      { id: 'task-b', projectId: 'proj-b' },
    ]);
  });

  it('falls back to single-id fetch when fetchTasksForProjects gets a single member', async () => {
    mockGet.mockResolvedValueOnce([]);

    await useTasksStore.getState().fetchTasksForProjects(['proj-only']);

    expect(mockGet).toHaveBeenCalledWith('/tasks?project_id=proj-only&recover_stale=1');
    expect(useTasksStore.getState().currentProjectFilter).toBe('proj-only');
    expect(useTasksStore.getState().currentProjectIds).toEqual([]);
  });

  it('drops a stale merged-group response once the active scope changes', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    mockGet.mockImplementation((url: string) => {
      if (url === '/tasks?project_ids=proj-a%2Cproj-b&recover_stale=1') {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (url === '/tasks?project_id=proj-c&recover_stale=1') {
        return Promise.resolve([
          {
            id: 'task-c',
            project_id: 'proj-c',
            title: 'C task',
            task_type: 'ai_task',
            status: 'running',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:01:00.000Z',
          },
        ]);
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const inFlight = useTasksStore.getState().fetchTasksForProjects(['proj-a', 'proj-b']);
    // User switches to a different single-project view while the merged
    // request is still pending.
    useTasksStore.getState().setProjectFilter('proj-c');

    resolveFirst?.([
      {
        id: 'stale',
        project_id: 'proj-a',
        title: 'Stale task',
        task_type: 'ai_task',
        status: 'running',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:01:00.000Z',
      },
    ]);
    await inFlight;
    // Let the proj-c fetch finish.
    await Promise.resolve();
    await Promise.resolve();

    expect(useTasksStore.getState().tasks).toMatchObject([
      { id: 'task-c', projectId: 'proj-c' },
    ]);
    expect(useTasksStore.getState().currentProjectFilter).toBe('proj-c');
    expect(useTasksStore.getState().currentProjectIds).toEqual([]);
  });
});
