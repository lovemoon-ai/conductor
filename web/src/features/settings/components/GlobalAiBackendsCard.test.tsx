import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GlobalAiBackendsCard } from './GlobalAiBackendsCard';

const saveMock = vi.fn();
const storeState = {
  backends: [] as Array<{ host: string; backend: string }>,
  hydrated: true,
  saving: false,
  error: null as string | null,
  hydrate: vi.fn(),
  save: saveMock,
};

vi.mock('@/features/user-preferences/global-ai-backends', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/user-preferences/global-ai-backends')>();
  return { ...actual, useGlobalAiBackendsStore: () => storeState };
});

const agents = [
  { id: '1', host: 'macmini', supportedBackends: ['claude', 'codex'] },
  { id: '2', host: 'ubuntu', supportedBackends: ['codex'] },
  { id: '3', host: 'borrowed', supportedBackends: ['claude'], shared: true },
  { id: '4', host: 'conductor-fire-macmini-1', supportedBackends: ['claude'] },
];

describe('GlobalAiBackendsCard', () => {
  beforeEach(() => {
    saveMock.mockReset();
    storeState.backends = [];
    storeState.error = null;
    storeState.hydrated = true;
  });

  it('does not allow saving before the saved list has loaded (a save replaces it)', () => {
    storeState.hydrated = false;
    render(<GlobalAiBackendsCard agents={agents} />);
    expect(screen.getByRole('checkbox', { name: 'claude @ macmini' })).toBeDisabled();
  });

  it('lists only your own daemons and saves a checked backend', () => {
    render(<GlobalAiBackendsCard agents={agents} />);
    expect(screen.queryByText('borrowed')).toBeNull();
    expect(screen.queryByText('conductor-fire-macmini-1')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'claude @ macmini' }));
    expect(saveMock).toHaveBeenCalledWith([{ host: 'macmini', backend: 'claude' }]);
  });

  it('keeps an offline daemon greyed out: its entries can be removed but not added', () => {
    storeState.backends = [{ host: 'studio', backend: 'claude' }];
    render(<GlobalAiBackendsCard agents={agents} />);
    expect(screen.getByText('offline')).toBeInTheDocument();

    const saved = screen.getByRole('checkbox', { name: 'claude @ studio' });
    expect(saved).toBeChecked();
    expect(saved).toBeEnabled();
    fireEvent.click(saved);
    expect(saveMock).toHaveBeenCalledWith([]);
  });

  it('shows a save error', () => {
    storeState.error = 'codex @ studio: daemon studio is offline';
    render(<GlobalAiBackendsCard agents={agents} />);
    expect(screen.getByRole('alert')).toHaveTextContent('daemon studio is offline');
  });
});
