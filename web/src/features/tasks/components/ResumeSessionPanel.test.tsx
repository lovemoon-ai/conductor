import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ResumeSessionPanel } from './ResumeSessionPanel';
import { ApiRequestError } from '@/shared/api/client';

const pushMock = vi.fn();
const createTaskMock = vi.fn();
const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

// A fresh account: the auto-created default project is the only project, and it
// has no daemonHost/workspacePath binding.
const fetchProjectsMock = vi.fn();

const projectsStoreState = (overrides: Record<string, unknown> = {}) => ({
  projects: [{ id: 'project-default', name: 'Default Project', isDefault: true, daemonHost: null }],
  isLoading: false,
  error: null,
  fetchProjects: fetchProjectsMock,
  ...overrides,
});

let projectsState: any = projectsStoreState();

const agentsState: any = {
  agents: [{ id: 'daemon-1', host: 'daemon-a', supportedBackends: ['claude'], capabilities: ['pty_task'] }],
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/shared/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/client')>();
  return { ...actual, getApiClient: () => ({ get: apiGetMock }) };
});

vi.mock('../store', () => ({
  useTasksStore: (selector: (state: { createTask: typeof createTaskMock }) => unknown) =>
    selector({ createTask: createTaskMock }),
}));

vi.mock('@/features/projects', async () => {
  const actual = await vi.importActual<typeof import('@/features/projects')>('@/features/projects');
  return {
    ...actual,
    useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
  };
});

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

const UNMATCHED_SESSION = {
  backend: 'claude',
  session_id: 'session-abc',
  session_file_path: '/Users/me/.claude/projects/demo/session-abc.jsonl',
  cwd: '/Users/me/code/demo',
  title: 'Fix the login bug',
  updated_at: new Date().toISOString(),
  linked_task_id: null,
  project_id: null,
};

describe('ResumeSessionPanel', () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    createTaskMock.mockResolvedValue({ id: 'task-1' });
    pushMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ sessions: [UNMATCHED_SESSION] });
    fetchProjectsMock.mockReset();
    projectsState = projectsStoreState();
  });

  it('falls back to the default project when the session matches no bound project', async () => {
    render(<ResumeSessionPanel onClose={() => {}} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));

    // No dead-end: the default project is preselected so resume works right
    // away on a fresh install with no daemon-bound projects.
    expect(screen.queryByText(/No project is available to attach this session to/)).not.toBeInTheDocument();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('project-default');

    const resumeButton = screen.getByRole('button', { name: 'Resume Session' });
    expect(resumeButton).not.toBeDisabled();
    fireEvent.click(resumeButton);

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-default',
        agentHost: 'daemon-a',
        backendType: 'claude',
        sessionId: 'session-abc',
      }),
    );
  });

  it('lets the user override the preselected default project', async () => {
    projectsState = projectsStoreState({
      projects: [
        { id: 'project-default', name: 'Default Project', isDefault: true, daemonHost: null },
        { id: 'project-bound', name: 'Bound Project', isDefault: false, daemonHost: 'daemon-a' },
      ],
    });

    render(<ResumeSessionPanel onClose={() => {}} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-bound' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume Session' }));

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-bound' }),
    );
  });

  it('still requires an explicit pick when the account has no default project', async () => {
    // Legacy accounts without a DefaultProject mapping: nothing is preselected,
    // so the placeholder stays and Resume waits for a deliberate choice.
    projectsState = projectsStoreState({
      projects: [{ id: 'project-bound', name: 'Bound Project', isDefault: false, daemonHost: 'daemon-a' }],
    });

    render(<ResumeSessionPanel onClose={() => {}} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));

    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('option', { name: 'Select a project…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume Session' })).toBeDisabled();
  });

  it('keeps the dead-end notice when no project is selectable at all', async () => {
    projectsState = projectsStoreState({
      projects: [{ id: 'project-other', name: 'Other Daemon', isDefault: false, daemonHost: 'daemon-b' }],
    });

    render(<ResumeSessionPanel onClose={() => {}} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));

    expect(screen.getByText(/No project is available to attach this session to/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument();
  });

  it('shows a loading notice instead of the dead-end while projects are still loading', async () => {
    projectsState = projectsStoreState({ projects: [], isLoading: true });

    render(<ResumeSessionPanel onClose={() => {}} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));

    expect(screen.getByText('Loading your projects…')).toBeInTheDocument();
    expect(screen.queryByText(/No project is available/)).not.toBeInTheDocument();
    expect(fetchProjectsMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed projects fetch with a retry instead of blaming the daemon binding', async () => {
    projectsState = projectsStoreState({ projects: [], error: 'Network error' });

    render(<ResumeSessionPanel onClose={() => {}} />);

    // An empty list on mount triggers exactly one recovery fetch.
    expect(fetchProjectsMock).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByText('Fix the login bug'));

    expect(screen.getByText('Could not load your projects')).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.queryByText(/No project is available/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fetchProjectsMock).toHaveBeenCalledTimes(2);
  });

  it('renders a session-listing failure with a retry that re-requests the daemon', async () => {
    apiGetMock.mockRejectedValueOnce(
      new ApiRequestError(404, { error: 'daemon_offline' }),
    );

    render(<ResumeSessionPanel onClose={() => {}} />);

    expect(
      await screen.findByText('Daemon is offline. Reconnect it before resuming a session.'),
    ).toBeInTheDocument();

    apiGetMock.mockResolvedValueOnce({ sessions: [UNMATCHED_SESSION] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Fix the login bug')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it('opens the existing task instead of creating a duplicate for a linked session', async () => {
    apiGetMock.mockResolvedValue({
      sessions: [{ ...UNMATCHED_SESSION, linked_task_id: 'task-existing' }],
    });
    const onClose = vi.fn();

    render(<ResumeSessionPanel onClose={onClose} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));

    expect(pushMock).toHaveBeenCalledWith('/app/tasks/task-existing');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('does not offer archived (hidden) projects in the project picker', async () => {
    projectsState = projectsStoreState({
      projects: [
        { id: 'project-default', name: 'Default Project', isDefault: true, daemonHost: null },
        { id: 'project-bound', name: 'Bound Project', isDefault: false, daemonHost: 'daemon-a' },
        { id: 'project-archived', name: 'Archived Project', isDefault: false, daemonHost: 'daemon-a', hidden: true },
      ],
    });
    render(<ResumeSessionPanel onClose={() => {}} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));

    const optionValues = Array.from((screen.getByLabelText('Project') as HTMLSelectElement).options)
      .map((option) => option.value);
    expect(optionValues).toEqual(expect.arrayContaining(['project-default', 'project-bound']));
    expect(optionValues).not.toContain('project-archived');
  });

  it('uses the project matched from the session cwd when there is one', async () => {
    projectsState = projectsStoreState({
      projects: [
        { id: 'project-default', name: 'Default Project', isDefault: true, daemonHost: null },
        { id: 'project-bound', name: 'Bound Project', isDefault: false, daemonHost: 'daemon-a' },
      ],
    });
    apiGetMock.mockResolvedValue({
      sessions: [{ ...UNMATCHED_SESSION, project_id: 'project-bound' }],
    });

    render(<ResumeSessionPanel onClose={() => {}} />);

    fireEvent.click(await screen.findByText('Fix the login bug'));
    expect(screen.getByText('Project: Bound Project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume Session' }));

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-bound' }),
    );
  });
});
