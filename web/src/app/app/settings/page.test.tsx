import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './page';

const pushMock = vi.fn();
const fetchAgentsMock = vi.fn();

const authState = {
  session: {
    jwtToken: 'jwt-1',
    userToken: 'user-token-1234567890',
    user: {
      id: 'user-1',
      email: 'test@example.com',
      phone: null,
    },
  },
};

const agentsState = {
  agents: [] as Array<{ id: string; host: string; supportedBackends?: string[] }>,
  fetchAgents: fetchAgentsMock,
  error: null as string | null,
  errorStatus: null as number | null,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/components/conductor/layout/Header', () => ({
  Header: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));

vi.mock('@/lib/conductor/stores/agents', () => ({
  useAgentsStore: () => agentsState,
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    pushMock.mockReset();
    fetchAgentsMock.mockReset();
    fetchAgentsMock.mockResolvedValue(undefined);
    agentsState.agents = [];
    agentsState.error = null;
    agentsState.errorStatus = null;
  });

  it('shows an auth prompt only for unauthorized daemon fetch errors', async () => {
    agentsState.error = 'Unauthorized';
    agentsState.errorStatus = 401;

    render(<SettingsPage />);

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalled();
    });
    expect(screen.getByText('Please log in to view connected daemons.')).toBeInTheDocument();
  });

  it('shows the real daemon fetch error for non-auth failures', async () => {
    agentsState.error = 'Request timeout';

    render(<SettingsPage />);

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalled();
    });
    expect(screen.getByText('Unable to load connected daemons.')).toBeInTheDocument();
    expect(screen.getByText('Request timeout')).toBeInTheDocument();
    expect(screen.queryByText('Please log in to view connected daemons.')).toBeNull();
  });
});
