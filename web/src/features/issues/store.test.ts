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
});
