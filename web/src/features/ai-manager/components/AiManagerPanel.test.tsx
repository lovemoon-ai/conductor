import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiManagerPanel } from './AiManagerPanel';
import type { StatusResponse, Tool } from '../types';

const fetchAgentsMock = vi.fn();
const setSelectedHostMock = vi.fn();
const fetchAllMock = vi.fn();
const startPollingMock = vi.fn();
const stopPollingMock = vi.fn();
const fetchQuotaMock = vi.fn();
const confirmMock = vi.fn();
const pushToastMock = vi.fn();
const apiPostMock = vi.fn();

let agentsState = {
  agents: [] as Array<{
    id: string;
    host: string;
    supportedBackends?: string[];
    runtimeBackendMap?: Record<string, string>;
    capabilities?: string[];
    version?: string;
  }>,
  fetchAgents: fetchAgentsMock,
};

let aiManagerState = {
  selectedHost: null as string | null,
  byHost: {} as Record<string, any>,
  setSelectedHost: setSelectedHostMock,
  fetchAll: fetchAllMock,
  fetchQuota: fetchQuotaMock,
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

const MANAGED_TOOLS: Tool[] = ['codex', 'claude', 'kimi', 'copilot'];

function makeStatus(
  overrides: Partial<Record<Tool, { installed?: boolean; reachable?: boolean }>> = {},
): StatusResponse {
  return {
    install: Object.fromEntries(
      MANAGED_TOOLS.map((tool) => [
        tool,
        { installed: overrides[tool]?.installed ?? true },
      ]),
    ) as StatusResponse['install'],
    network: Object.fromEntries(
      MANAGED_TOOLS.map((tool) => [
        tool,
        { reachable: overrides[tool]?.reachable ?? true, endpoint: '' },
      ]),
    ) as StatusResponse['network'],
    currentCodexAccount: null,
  };
}

function makeHostState(status: StatusResponse) {
  return {
    status,
    quota: {
      codex: {
        tool: 'codex',
        source: 'fresh',
        fiveHour: { usedPercent: 10, remainingPercent: 90 },
        weekly: { usedPercent: 20, remainingPercent: 80 },
      },
      claude: {
        tool: 'claude',
        source: 'fresh',
        fiveHour: { usedPercent: 10, remainingPercent: 90 },
        weekly: { usedPercent: 20, remainingPercent: 80 },
      },
      kimi: {
        tool: 'kimi',
        source: 'fresh',
        fiveHour: { usedPercent: 10, remainingPercent: 90 },
        weekly: { usedPercent: 20, remainingPercent: 80 },
      },
      copilot: {
        tool: 'copilot',
        source: 'fresh',
        primary: { usedPercent: 10, remainingPercent: 90, status: 'allowed' },
        snapshots: {},
      },
    },
    accounts: { accounts: [] },
    codexQuotaByAccount: {},
    loading: { status: false, quota: false, accounts: false, switching: false },
    error: {},
  };
}

describe('AiManagerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAgentsMock.mockResolvedValue(undefined);
    fetchAllMock.mockResolvedValue(undefined);
    fetchQuotaMock.mockResolvedValue(undefined);
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
      fetchQuota: fetchQuotaMock,
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

  it('renders supported backends and daemon CLI version in the info card', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['codex', 'claude'],
        capabilities: ['restart_daemon'],
        version: '1.2.3',
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    const backendsTerm = screen.getByText('Supported backends');
    const backendsValue = backendsTerm.parentElement?.querySelector('dd');
    expect(backendsValue?.textContent).toBe('codex, claude');

    const versionTerm = screen.getByText('Daemon CLI version');
    const versionValue = versionTerm.parentElement?.querySelector('dd');
    expect(versionValue?.textContent).toBe('1.2.3');
  });

  it('falls back to "unknown" when the daemon CLI version is absent', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-legacy',
        supportedBackends: ['codex'],
        capabilities: ['restart_daemon'],
        // version intentionally omitted (legacy daemon without x-conductor-version header)
      },
    ];
    aiManagerState.selectedHost = 'daemon-legacy';

    render(<AiManagerPanel initialAgentHost="daemon-legacy" />);

    const versionTerm = screen.getByText('Daemon CLI version');
    const versionValue = versionTerm.parentElement?.querySelector('dd');
    expect(versionValue?.textContent).toBe('unknown');
  });

  it('renders an em-dash when the daemon advertises no supported backends', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-empty',
        supportedBackends: [],
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-empty';

    render(<AiManagerPanel initialAgentHost="daemon-empty" />);

    const backendsTerm = screen.getByText('Supported backends');
    const backendsValue = backendsTerm.parentElement?.querySelector('dd');
    expect(backendsValue?.textContent).toBe('—');
  });

  it('renders AI tool and quota sections only for known tools advertised by the selected daemon', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['codex-gamma', 'web-gemini', 'copilot'],
        runtimeBackendMap: {
          'codex-gamma': 'codex',
          'web-gemini': 'chat-web',
          copilot: 'copilot',
        },
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';
    aiManagerState.byHost = {
      'daemon-a': makeHostState(makeStatus()),
    };

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    const aiToolsSection = screen.getByRole('heading', { name: 'AI tools' }).closest('section');
    expect(aiToolsSection).not.toBeNull();
    expect(within(aiToolsSection!).getByText('Codex')).toBeInTheDocument();
    expect(within(aiToolsSection!).getByText('Copilot')).toBeInTheDocument();
    expect(within(aiToolsSection!).queryByText('Claude')).not.toBeInTheDocument();
    expect(within(aiToolsSection!).queryByText('Kimi')).not.toBeInTheDocument();

    const quotaSection = screen.getByRole('heading', { name: 'Quota' }).closest('section');
    expect(quotaSection).not.toBeNull();
    expect(within(quotaSection!).getByText('Codex')).toBeInTheDocument();
    expect(within(quotaSection!).getByText(/Copilot/)).toBeInTheDocument();
    expect(within(quotaSection!).queryByText('Claude')).not.toBeInTheDocument();
    expect(within(quotaSection!).queryByText('Kimi')).not.toBeInTheDocument();
    expect(within(quotaSection!).queryByText('External providers')).not.toBeInTheDocument();
    expect(within(quotaSection!).queryByText('web-gemini')).not.toBeInTheDocument();
    expect(within(quotaSection!).queryByText('codex-gamma')).not.toBeInTheDocument();
    expect(fetchAllMock).toHaveBeenCalledWith('daemon-a', { externalQuotaBackends: [] });
    expect(startPollingMock).toHaveBeenCalledWith('daemon-a', { externalQuotaBackends: [] });
  });

  it('hides advertised tools when install or network status marks them unavailable', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['codex', 'claude', 'kimi', 'copilot'],
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';
    aiManagerState.byHost = {
      'daemon-a': makeHostState(makeStatus({
        claude: { installed: false },
        kimi: { reachable: false },
      })),
    };

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    const aiToolsSection = screen.getByRole('heading', { name: 'AI tools' }).closest('section');
    expect(aiToolsSection).not.toBeNull();
    expect(within(aiToolsSection!).getByText('Codex')).toBeInTheDocument();
    expect(within(aiToolsSection!).getByText('Copilot')).toBeInTheDocument();
    expect(within(aiToolsSection!).queryByText('Claude')).not.toBeInTheDocument();
    expect(within(aiToolsSection!).queryByText('Kimi')).not.toBeInTheDocument();

    const quotaSection = screen.getByRole('heading', { name: 'Quota' }).closest('section');
    expect(quotaSection).not.toBeNull();
    expect(within(quotaSection!).getByText('Codex')).toBeInTheDocument();
    expect(within(quotaSection!).getByText(/Copilot/)).toBeInTheDocument();
    expect(within(quotaSection!).queryByText('Claude')).not.toBeInTheDocument();
    expect(within(quotaSection!).queryByText('Kimi')).not.toBeInTheDocument();
  });

  it('does not render advertised tools in Quota until status confirms they are installed and reachable', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['codex', 'claude', 'kimi', 'copilot'],
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';
    // status not yet loaded (initial fetch in flight).
    aiManagerState.byHost = {
      'daemon-a': {
        status: null,
        loading: { status: true, quota: false, accounts: false, switching: false },
        error: {},
      },
    };

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    const quotaSection = screen.getByRole('heading', { name: 'Quota' }).closest('section');
    expect(quotaSection).not.toBeNull();
    // While status is still loading, the Quota section should show a
    // loading state — not advertised-but-unverified tool cards.
    expect(within(quotaSection!).getByText('Loading quota...')).toBeInTheDocument();
    expect(within(quotaSection!).queryByText('Codex')).not.toBeInTheDocument();
    expect(within(quotaSection!).queryByText(/Copilot/)).not.toBeInTheDocument();
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
        // Without status the Quota section now correctly hides every tool
        // (P2 fix). Provide a minimal status that marks Copilot
        // installed + reachable so this test exercises the inline-login
        // rendering it actually cares about.
        status: {
          install: { copilot: { installed: true } },
          network: { copilot: { reachable: true, endpoint: '' } },
          currentCodexAccount: null,
        },
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

  it('requests and renders external model quotas for external-capable daemons', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['private-ext'],
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';
    aiManagerState.byHost = {
      'daemon-a': {
        quota: {
          external: {
            'private-ext': {
              backend: 'private-ext',
              source: 'fresh',
              count: 1,
              username: 'dui',
              label: 'Private Provider',
              quotas: [
                {
                  backend: 'private-ext',
                  model: 'model-paygo',
                  source: 'fresh',
                  daily: {
                    usedPercent: 40,
                    remainingPercent: 60,
                    remaining: 120_000,
                    limit: 200_000,
                  },
                },
              ],
            },
          },
        },
      },
    };

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    expect(fetchAllMock).toHaveBeenCalledWith('daemon-a', { externalQuotaBackends: ['private-ext'] });
    expect(startPollingMock).toHaveBeenCalledWith('daemon-a', { externalQuotaBackends: ['private-ext'] });
    expect(screen.getByText('External providers')).toBeInTheDocument();
    expect(screen.getByText('Private Provider')).toBeInTheDocument();
    expect(screen.getByText('model-paygo')).toBeInTheDocument();
    expect(screen.getByText('已用 40% · 剩余 60%')).toBeInTheDocument();
    expect(screen.queryByText('120,000 / 200,000 tokens')).not.toBeInTheDocument();
  });

  it('hides external backends when the provider returns no model quota data', () => {
    agentsState.agents = [
      {
        id: 'agent-1',
        host: 'daemon-a',
        supportedBackends: ['private-ext', 'empty-ext'],
        capabilities: ['restart_daemon'],
      },
    ];
    aiManagerState.selectedHost = 'daemon-a';
    aiManagerState.byHost = {
      'daemon-a': {
        quota: {
          external: {
            'private-ext': {
              backend: 'private-ext',
              source: 'fresh',
              count: 1,
              label: 'Private Provider',
              quotas: [
                {
                  backend: 'private-ext',
                  model: 'model-paygo',
                  source: 'fresh',
                  daily: {
                    usedPercent: 40,
                    remainingPercent: 60,
                  },
                },
              ],
            },
            'empty-ext': {
              backend: 'empty-ext',
              source: 'unknown',
              count: 0,
              label: 'Empty Provider',
              quotas: [],
              error: 'external provider quota list hook unavailable',
            },
          },
        },
      },
    };

    render(<AiManagerPanel initialAgentHost="daemon-a" />);

    expect(fetchAllMock).toHaveBeenCalledWith('daemon-a', {
      externalQuotaBackends: ['private-ext', 'empty-ext'],
    });
    expect(screen.getByText('External providers')).toBeInTheDocument();
    expect(screen.getByText('Private Provider')).toBeInTheDocument();
    expect(screen.getByText('model-paygo')).toBeInTheDocument();
    expect(screen.queryByText('Empty Provider')).not.toBeInTheDocument();
    expect(screen.queryByText('No external model quota data yet.')).not.toBeInTheDocument();
  });
});
