import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AchievedTaskManager } from './AchievedTaskManager';
import { useAchievedTasksStore } from '../store';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => apiMocks,
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    payload: unknown;

    constructor(status: number, payload: { message?: string; error?: string }) {
      super(payload?.message || payload?.error || `HTTP ${status}`);
      this.status = status;
      this.payload = payload;
    }
  },
}));

const pushToast = vi.fn();
const confirm = vi.fn();
vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({ pushToast }),
  useConfirm: () => ({ confirm }),
}));

const agentsState = vi.hoisted(() => ({
  agents: [
    { host: 'daemon-a', supportedBackends: ['codex', 'claude'] },
    { host: 'daemon-b', supportedBackends: ['codex', 'claude'] },
  ],
  fetchAgents: vi.fn(),
}));
vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

const projectsState = vi.hoisted(() => ({
  projects: [
    { id: 'proj-1', name: 'Papers', daemonHost: 'daemon-a' },
    { id: 'proj-2', name: 'Conductor', daemonHost: 'daemon-a' },
    { id: 'proj-3', name: 'Conductor', daemonHost: 'daemon-b' },
    {
      id: 'proj-4',
      name: 'Conductor',
      daemonHost: 'daemon-a',
      gitRemoteUrl: 'https://example.com/a.git',
    },
  ],
  fetchProjects: vi.fn(),
}));
vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) =>
    selector(projectsState),
}));

vi.mock('./ReadOnlyTranscript', () => ({
  ReadOnlyTranscript: ({ taskId }: { taskId: string }) => (
    <div>Transcript content for {taskId}</div>
  ),
}));

const ACHIEVED = {
  id: 'ai-1',
  title: 'Reading the diffusion paper',
  projectId: 'proj-1',
  projectName: 'Papers',
  backendType: 'codex',
  agentHost: 'daemon-a',
  status: 'killed' as const,
  achievedAt: '2026-03-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  snippet: 'Hidden transcript snippet',
  messageCount: 12,
};

const pageResponse = (page: number) => ({
  tasks:
    page === 1
      ? [ACHIEVED]
      : [{ ...ACHIEVED, id: 'ai-11', title: 'The eleventh archived task' }],
  total: 11,
  page,
  pageSize: 10,
  totalPages: 2,
});

describe('AchievedTaskManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAchievedTasksStore.setState({
      query: '',
      projectIds: [],
      tasks: [],
      total: 0,
      page: 1,
      pageSize: 10,
      totalPages: 0,
      loading: false,
      hydrated: false,
      error: null,
    });
    apiMocks.get.mockImplementation(async (url: string) => {
      const page = new URL(url, 'http://localhost').searchParams.get('page');
      return pageResponse(page === '2' ? 2 : 1);
    });
    apiMocks.post.mockResolvedValue({ task: { id: 'new-task-1' } });
    apiMocks.delete.mockResolvedValue(undefined);
    confirm.mockResolvedValue(true);
  });

  it('loads at most ten tasks and keeps collapsed rows title-only', async () => {
    render(<AchievedTaskManager />);

    expect(await screen.findByText(ACHIEVED.title)).toBeInTheDocument();
    expect(apiMocks.get).toHaveBeenCalledWith('/tasks/achieved?page=1&limit=10');
    const projectFilter = screen.getByRole('combobox', { name: 'Filter by project' });
    const searchInput = screen.getByRole('searchbox', { name: 'Search archived tasks' });
    const searchButton = screen.getByRole('button', { name: 'Search' });
    expect(projectFilter).not.toHaveClass('h-10');
    expect(projectFilter.closest('form')).toHaveClass('items-stretch');
    expect(searchInput).toHaveClass('h-full', 'min-h-12');
    expect(searchButton).toHaveClass('min-h-12');
    const row = screen.getByTestId('achieved-task-ai-1');
    expect(within(row).queryByText(ACHIEVED.projectName)).toBeNull();
    expect(within(row).queryByText(ACHIEVED.snippet)).toBeNull();
    expect(within(row).queryByText('12 messages')).toBeNull();
    expect(within(row).queryByText('New')).toBeNull();
    expect(within(row).queryByText('Transcript content for ai-1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: ACHIEVED.title }));
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recover' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByText('Transcript content for ai-1')).toBeInTheDocument();
  });

  it('searches only when the Search button is submitted', async () => {
    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);
    expect(apiMocks.get).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search archived tasks' }), {
      target: { value: 'diffusion' },
    });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith(
        '/tasks/achieved?q=diffusion&page=1&limit=10',
      );
    });
    expect(await screen.findByText('diffusion')).toHaveProperty('tagName', 'MARK');
  });

  it('merges same-name projects into one filter and keeps the group across pages', async () => {
    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);

    const projectFilter = screen.getByRole('combobox', { name: 'Filter by project' });
    expect(projectFilter).toHaveValue('');
    const conductorOptions = screen.getAllByRole('option', { name: 'Conductor' });
    expect(conductorOptions).toHaveLength(1);
    const mergedGroupValue = (conductorOptions[0] as HTMLOptionElement).value;

    fireEvent.change(projectFilter, { target: { value: mergedGroupValue } });

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith(
        '/tasks/achieved?projectIds=proj-2%2Cproj-3%2Cproj-4&page=1&limit=10',
      );
    });
    expect(projectFilter).toHaveValue(mergedGroupValue);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith(
        '/tasks/achieved?projectIds=proj-2%2Cproj-3%2Cproj-4&page=2&limit=10',
      );
    });
  });

  it('loads the next ten-task page', async () => {
    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('The eleventh archived task')).toBeInTheDocument();
    expect(apiMocks.get).toHaveBeenCalledWith('/tasks/achieved?page=2&limit=10');
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('recovers an expanded task and navigates to it', async () => {
    apiMocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/unachieve')) {
        return { strategy: 'inplace', agentHost: 'daemon-a', taskId: 'ai-1' };
      }
      return { task: { id: 'ai-1' } };
    });

    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);
    fireEvent.click(screen.getByRole('button', { name: ACHIEVED.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }));

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('/tasks/ai-1/unachieve', {});
    });
    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('/tasks/ai-1/restart', {
        strategy: 'inplace',
        agent_host: 'daemon-a',
      });
    });
    expect(push).toHaveBeenCalledWith('/app/tasks/ai-1');
  });

  it('creates a new task with selected daemon/backend defaults and navigates', async () => {
    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);
    fireEvent.click(screen.getByRole('button', { name: ACHIEVED.title }));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    const daemonSelect = await screen.findByRole('combobox', { name: 'Daemon' });
    const backendSelect = screen.getByRole('combobox', { name: 'Backend' });
    expect(daemonSelect).toHaveValue('daemon-a');
    expect(backendSelect).toHaveValue('codex');

    fireEvent.change(daemonSelect, { target: { value: 'daemon-b' } });
    fireEvent.change(backendSelect, { target: { value: 'claude' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'New' }),
    );

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('/tasks/ai-1/restart', {
        strategy: 'new_task',
        agent_host: 'daemon-b',
        backend_type: 'claude',
      });
    });
    expect(push).toHaveBeenCalledWith('/app/tasks/new-task-1');
  });

  it('defaults New to the durable daemon association for a manual-fire archive', async () => {
    apiMocks.get.mockResolvedValueOnce({
      ...pageResponse(1),
      tasks: [
        {
          ...ACHIEVED,
          agentHost: 'conductor-fire-old-session',
          daemonHost: 'daemon-b',
        },
      ],
    });

    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);
    fireEvent.click(screen.getByRole('button', { name: ACHIEVED.title }));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(await screen.findByRole('combobox', { name: 'Daemon' })).toHaveValue(
      'daemon-b',
    );
    expect(screen.getByRole('combobox', { name: 'Backend' })).toHaveValue('codex');
  });

  it('permanently deletes an archived task after confirmation and refreshes the page', async () => {
    apiMocks.get
      .mockResolvedValueOnce(pageResponse(1))
      .mockResolvedValueOnce({
        tasks: [],
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 0,
      });

    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);
    fireEvent.click(screen.getByRole('button', { name: ACHIEVED.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith({
        title: 'Permanently delete this archived task?',
        description: expect.stringContaining('It cannot be recovered.'),
        confirmLabel: 'Delete permanently',
        tone: 'danger',
      });
    });
    await waitFor(() => {
      expect(apiMocks.delete).toHaveBeenCalledWith('/tasks/ai-1?permanent=1');
    });
    await waitFor(() => {
      expect(screen.queryByText(ACHIEVED.title)).toBeNull();
    });
    expect(pushToast).toHaveBeenCalledWith({
      title: 'Archived task deleted',
      description: 'The task and its retained history were permanently removed.',
      variant: 'success',
    });
  });

  it('keeps an archived task when permanent deletion is cancelled', async () => {
    confirm.mockResolvedValueOnce(false);

    render(<AchievedTaskManager />);
    await screen.findByText(ACHIEVED.title);
    fireEvent.click(screen.getByRole('button', { name: ACHIEVED.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalled();
    });
    expect(apiMocks.delete).not.toHaveBeenCalled();
    expect(screen.getByText(ACHIEVED.title)).toBeInTheDocument();
  });
});
