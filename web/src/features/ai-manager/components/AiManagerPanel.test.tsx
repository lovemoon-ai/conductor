import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiManagerPanel } from './AiManagerPanel';

const fetchAgentsMock = vi.fn();
const setSelectedHostMock = vi.fn();
const fetchAllMock = vi.fn();
const startPollingMock = vi.fn();
const stopPollingMock = vi.fn();
const confirmMock = vi.fn();
const pushToastMock = vi.fn();
const apiPostMock = vi.fn();

let agentsState = {
  agents: [] as Array<{
    id: string;
    host: string;
    supportedBackends?: string[];
    capabilities?: string[];
  }>,
  fetchAgents: fetchAgentsMock,
};

let aiManagerState = {
  selectedHost: null as string | null,
  byHost: {} as Record<string, any>,
  setSelectedHost: setSelectedHostMock,
  fetchAll: fetchAllMock,
  startPolling: startPollingMock,
  stopPolling: stopPollingMock,
};

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('../store', () => ({
  useAiManagerStore: (selector: (state: typeof aiManagerState) => unknown) => selector(aiManagerState),
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useConfirm: () => ({
    confirm: confirmMock,
  }),
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    post: apiPostMock,
  }),
}));

describe('AiManagerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAgentsMock.mockResolvedValue(undefined);
    fetchAllMock.mockResolvedValue(undefined);
    confirmMock.mockResolvedValue(true);
    apiPostMock.mockResolvedValue({});
    agentsState = {
      agents: [],
      fetchAgents: fetchAgentsMock,
    };
    aiManagerState = {
      selectedHost: null,
      byHost: {},
      setSelectedHost: setSelectedHostMock,
      fetchAll: fetchAllMock,
      startPolling: startPollingMock,
      stopPolling: stopPollingMock,
    };
  });

  it('renders daemon restart as a bottom card and requests restart from the selected daemon page', async () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['codex'],
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeInTheDocument();
    expect(screen.getByText('Restart daemon')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Restart daemon on daemon-a'));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Restart daemon on daemon-a?',
        confirmLabel: 'Restart',
      }));
      expect(apiPostMock).toHaveBeenCalledWith('/agents/daemon-a/restart', { targetVersion: 'latest' });
    });
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Restart requested',
      variant: 'success',
    }));
  });

  it('disables the restart card action when the daemon lacks restart capability', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-old',
        supportedBackends: ['codex'],
        capabilities: ['project_path_validation'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-old';

    render(<AiManagerPanel initialAgentHost="daemon-old" />);

    expect(screen.getByLabelText('Restart daemon on daemon-old')).toBeDisabled();
  });

  it('shows the Copilot login label inline with the header when quota data includes account info', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['copilot'],
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';
    aiManagerState.byHost = {
      'daemon-a': {
        quota: {
          copilot: {
            tool: 'copilot',
            source: 'fresh',
            login: 'octocat',
            loginSource: 'github_token',
            primary: {
              usedPercent: 0,
              remainingPercent: 100,
              status: 'allowed',
            },
            snapshots: {},
          },
        },
      },
    };

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    const loginLabel = screen.getByText(/\(octocat via GITHUB_TOKEN\)/);
    expect(loginLabel).toBeInTheDocument();
    // The login label should live inside the "Copilot" header row, not in a
    // separate paragraph below it.
    expect(loginLabel.tagName).toBe('SPAN');
    const headerRow = loginLabel.closest('div');
    expect(headerRow).not.toBeNull();
    // JSX collapses the whitespace around sibling expressions, so textContent
    // is concatenated directly. Allow zero whitespace but still assert order.
    // The `uppercase` Tailwind class on the status pill is a visual-only
    // transform and does not affect textContent, so we match case-insensitively
    // — what we actually care about is the structure/order.
    expect(headerRow?.textContent ?? '').toMatch(/^Copilot\s*allowed\s*\(octocat via GITHUB_TOKEN\)/i);
  });
});
