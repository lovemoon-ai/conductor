import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollaborationInvitePage from './page';

const fetchProjectsMock = vi.fn();
const pushToastMock = vi.fn();
const routerPushMock = vi.fn();
const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'invite-token' }),
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: { fetchProjects: typeof fetchProjectsMock }) => unknown) =>
    selector({ fetchProjects: fetchProjectsMock }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: apiGetMock,
    post: apiPostMock,
  }),
}));

const buildInvite = (overrides: Record<string, unknown> = {}) => ({
  collaboration: {
    id: 'collab-1',
    memberCount: 1,
    maxMembers: 5,
    members: [
      {
        userId: 'user-1',
        label: 'Owner',
        projectName: 'conductor',
      },
    ],
  },
  candidateProjects: [],
  alreadyJoined: false,
  isFull: false,
  suggestedProjectName: 'conductor',
  suggestedProjectNameExists: false,
  suggestedProjectNameAvailable: true,
  ...overrides,
});

describe('CollaborationInvitePage', () => {
  beforeEach(() => {
    fetchProjectsMock.mockReset().mockResolvedValue(undefined);
    pushToastMock.mockReset();
    routerPushMock.mockReset();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
  });

  it('hides the create-project action when the suggested project name already exists', async () => {
    apiGetMock.mockResolvedValueOnce(buildInvite({
      candidateProjects: [
        {
          id: 'project-existing',
          name: 'conductor',
          daemonHost: null,
          workspacePath: null,
          alreadyInCollaboration: true,
          canJoin: false,
        },
      ],
      suggestedProjectNameExists: true,
      suggestedProjectNameAvailable: false,
    }));

    render(<CollaborationInvitePage />);

    expect(await screen.findByText('Project already exists')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create "conductor" & join' })).not.toBeInTheDocument();
    expect(screen.queryByText('Or create a brand new project for this collaboration')).not.toBeInTheDocument();
  });

  it('selects an existing same-name project for joining instead of offering duplicate creation', async () => {
    apiGetMock.mockResolvedValueOnce(buildInvite({
      candidateProjects: [
        {
          id: 'project-other',
          name: 'other',
          daemonHost: null,
          workspacePath: null,
          alreadyInCollaboration: false,
          canJoin: true,
        },
        {
          id: 'project-conductor',
          name: 'conductor',
          daemonHost: 'local-daemon',
          workspacePath: '/repo/conductor',
          alreadyInCollaboration: false,
          canJoin: true,
        },
      ],
      suggestedProjectNameExists: true,
      suggestedProjectNameAvailable: false,
    }));
    apiPostMock.mockResolvedValueOnce({});

    render(<CollaborationInvitePage />);

    const select = await screen.findByLabelText('Pair with project') as HTMLSelectElement;
    expect(select.value).toBe('project-conductor');
    expect(screen.queryByText('Or create a brand new project for this collaboration')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/collaboration/join', {
        inviteToken: 'invite-token',
        projectId: 'project-conductor',
      });
    });
  });

  it('can create and join only when the suggested project name is available', async () => {
    apiGetMock.mockResolvedValueOnce(buildInvite());
    apiPostMock.mockResolvedValueOnce({ projectId: 'project-created' });

    render(<CollaborationInvitePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create "conductor" & join' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/collaboration/join', {
        inviteToken: 'invite-token',
        createProjectName: 'conductor',
      });
    });
    expect(fetchProjectsMock).toHaveBeenCalledTimes(1);
    expect(routerPushMock).toHaveBeenCalledWith('/app/issues?projectId=project-created');
  });

  it('hides create after the backend reports the suggested project name is taken', async () => {
    apiGetMock.mockResolvedValueOnce(buildInvite());
    apiPostMock.mockRejectedValueOnce(new Error('Project name already exists'));

    render(<CollaborationInvitePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create "conductor" & join' }));

    expect(await screen.findByText('Project name already exists')).toBeInTheDocument();
    expect(screen.getByText('Project already exists')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create "conductor" & join' })).not.toBeInTheDocument();
  });
});
