import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexAccountSwitcher } from './CodexAccountSwitcher';

vi.mock('../store', () => ({
  useAiManagerStore: (selector: (state: unknown) => unknown) =>
    selector({
      switchAccount: vi.fn(),
      byHost: {
        'daemon-a': {
          loading: { switching: false },
          error: {},
        },
      },
    }),
}));

describe('CodexAccountSwitcher', () => {
  it('shows only the weekly quota for current Codex versions', () => {
    render(
      <CodexAccountSwitcher
        agentHost="daemon-a"
        accounts={[
          {
            name: 'alice',
            path: '/tmp/alice.json',
            email: 'alice@example.com',
            isCurrent: true,
          },
        ]}
        codexQuotaByAccount={{
          alice: {
            tool: 'codex',
            source: 'fresh',
            weekly: {
              usedPercent: 33,
              remainingPercent: 67,
              windowMinutes: 10080,
            },
          },
        }}
      />,
    );

    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Weekly usage' })).toHaveAttribute(
      'aria-valuenow',
      '33',
    );
    expect(screen.queryByText('5h')).not.toBeInTheDocument();
  });
});
