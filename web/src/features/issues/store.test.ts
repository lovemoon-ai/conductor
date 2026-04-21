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

import { useIssuesStore } from './store';

describe('issues store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useIssuesStore.setState({
      issues: [],
      isLoading: false,
      error: null,
      currentProjectId: null,
    });
  });

  it('fetches all issues when no project is selected', async () => {
    mockGet.mockResolvedValueOnce([
      {
        id: 'issue-1',
        project_id: 'project-1',
        title: 'Plan all issues view',
        status: 'todo',
        position: 0,
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-19T00:01:00.000Z',
      },
      {
        id: 'issue-2',
        project_id: 'project-2',
        title: 'Keep cross-project issue visible',
        status: 'doing',
        position: 1,
        created_at: '2026-04-19T00:02:00.000Z',
        updated_at: '2026-04-19T00:03:00.000Z',
      },
    ]);

    await useIssuesStore.getState().fetchIssues(null);

    expect(mockGet).toHaveBeenCalledWith('/issues');
    expect(useIssuesStore.getState()).toMatchObject({
      currentProjectId: null,
      isLoading: false,
      error: null,
    });
    expect(useIssuesStore.getState().issues.map((issue) => issue.projectId)).toEqual([
      'project-1',
      'project-2',
    ]);
  });

  it('fetches project-scoped issues when a project is selected', async () => {
    mockGet.mockResolvedValueOnce([
      {
        id: 'issue-1',
        project_id: 'project-1',
        title: 'Project issue',
        status: 'todo',
        position: 0,
        created_at: '2026-04-19T00:00:00.000Z',
      },
    ]);

    await useIssuesStore.getState().fetchIssues('project-1');

    expect(mockGet).toHaveBeenCalledWith('/issues?project_id=project-1');
    expect(useIssuesStore.getState()).toMatchObject({
      currentProjectId: 'project-1',
      isLoading: false,
      error: null,
    });
    expect(useIssuesStore.getState().issues).toHaveLength(1);
  });

  it('normalizes linked historical tasks from issue responses', async () => {
    mockGet.mockResolvedValueOnce([
      {
        id: 'issue-1',
        project_id: 'project-1',
        title: 'Reopenable issue',
        status: 'done',
        position: 0,
        linked_task: {
          id: 'task-1',
          project_id: 'project-1',
          issue_id: 'issue-1',
          title: 'Reopenable task',
          status: 'killed',
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:01:00.000Z',
        },
        created_at: '2026-04-19T00:00:00.000Z',
      },
    ]);

    await useIssuesStore.getState().fetchIssues('project-1');

    expect(useIssuesStore.getState().issues[0]).toMatchObject({
      id: 'issue-1',
      linkedTask: expect.objectContaining({
        id: 'task-1',
        status: 'killed',
      }),
      activeTask: null,
    });
  });

  it('updates issue-linked task metadata from mutation responses', async () => {
    mockPatch.mockResolvedValueOnce({
      issue: {
        id: 'issue-1',
        project_id: 'project-1',
        title: 'Reopenable issue',
        status: 'doing',
        position: 0,
        active_task: {
          id: 'task-1',
          project_id: 'project-1',
          issue_id: 'issue-1',
          title: 'Reopenable task',
          status: 'running',
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:01:00.000Z',
        },
        linked_task: {
          id: 'task-1',
          project_id: 'project-1',
          issue_id: 'issue-1',
          title: 'Reopenable task',
          status: 'running',
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:01:00.000Z',
        },
        created_at: '2026-04-19T00:00:00.000Z',
      },
      active_task: {
        id: 'task-1',
        project_id: 'project-1',
        issue_id: 'issue-1',
        title: 'Reopenable task',
        status: 'running',
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-19T00:01:00.000Z',
      },
    });
    useIssuesStore.setState({
      issues: [
        {
          id: 'issue-1',
          projectId: 'project-1',
          title: 'Reopenable issue',
          status: 'done',
          position: 0,
          createdAt: '2026-04-19T00:00:00.000Z',
          linkedTask: {
            id: 'task-1',
            projectId: 'project-1',
            issueId: 'issue-1',
            title: 'Reopenable task',
            status: 'killed',
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-19T00:01:00.000Z',
          },
        },
      ],
      isLoading: false,
      error: null,
      currentProjectId: 'project-1',
    });

    const issue = await useIssuesStore.getState().updateIssue('issue-1', { status: 'doing' });

    expect(issue).toMatchObject({
      id: 'issue-1',
      status: 'doing',
      activeTask: expect.objectContaining({ id: 'task-1', status: 'running' }),
      linkedTask: expect.objectContaining({ id: 'task-1', status: 'running' }),
    });
  });
});
