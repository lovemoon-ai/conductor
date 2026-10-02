import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MoveIssueToDoingDialog, type MoveIssueToDoingDaemonOption } from './MoveIssueToDoingDialog';

const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({ get: apiGetMock }),
}));

vi.mock('@/components/common/Dialog', () => ({
  Dialog: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
  }) => (open ? (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ) : null),
}));

const SINGLE_DAEMON: MoveIssueToDoingDaemonOption[] = [
  {
    host: 'daemon-a',
    projectId: 'project-a',
    supportedBackends: ['claude', 'codex'],
  },
];

const MERGED_DAEMONS: MoveIssueToDoingDaemonOption[] = [
  {
    host: 'daemon-a',
    projectId: 'project-a',
    supportedBackends: ['claude', 'codex'],
  },
  {
    host: 'daemon-b',
    projectId: 'project-b',
    supportedBackends: ['claude'],
  },
];

describe('MoveIssueToDoingDialog', () => {
  it('hides the daemon picker when only one daemon is available so the dialog stays focused on backend selection', () => {
    // Per product spec rule #1: single-daemon projects (and merged-group
    // projects that only have one daemon currently online) do not need a
    // daemon row — there is no choice to make. The IssueCard daemon tag
    // continues to surface "where the task ran" after the fact.
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={SINGLE_DAEMON}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.queryByLabelText('Daemon')).toBeNull();
    expect(screen.getByLabelText('Backend')).toHaveValue('claude');
  });

  it('shows a daemon picker for merged groups with multiple online daemons', () => {
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={MERGED_DAEMONS}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    const daemonSelect = screen.getByLabelText('Daemon');
    expect(daemonSelect).toHaveValue('daemon-a');
    expect(daemonSelect).toHaveDisplayValue('daemon-a');
  });

  it('re-filters the backend list when the user switches daemon', () => {
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={MERGED_DAEMONS}
        initialBackend="codex"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    // daemon-a supports codex, so the initial backend defaults to codex.
    expect(screen.getByLabelText('Backend')).toHaveValue('codex');

    fireEvent.change(screen.getByLabelText('Daemon'), { target: { value: 'daemon-b' } });

    // daemon-b only supports claude, so the backend collapses to the only
    // option it advertises rather than staying on the unsupported codex.
    expect(screen.getByLabelText('Backend')).toHaveValue('claude');
  });

  it('confirms with the picked daemon + its sibling projectId', async () => {
    const onConfirm = vi.fn();

    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={MERGED_DAEMONS}
        initialDaemon="daemon-b"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-b');

    // handleConfirm flips isSubmitting around the awaited onConfirm; wrap the
    // click so React flushes the state updates inside one act batch.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Move To Doing' }));
    });

    expect(onConfirm).toHaveBeenCalledWith({
      backendType: 'claude',
      daemonHost: 'daemon-b',
      projectId: 'project-b',
    });
  });

  it('honours the metadata-supplied initial daemon when it is still online', () => {
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={MERGED_DAEMONS}
        initialDaemon="daemon-b"
        initialBackend="claude"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-b');
    expect(screen.getByLabelText('Backend')).toHaveValue('claude');
  });

  it('falls back to the first daemon when the previous one is no longer online', () => {
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={MERGED_DAEMONS}
        // daemon-c was the previous run but is offline now (not in options).
        initialDaemon="daemon-c"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-a');
  });

  it('surfaces an offline-fallback hint when the last-used daemon is no longer in the option list', () => {
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={MERGED_DAEMONS}
        initialDaemon="daemon-c"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    const hint = screen.getByRole('status');
    expect(hint.textContent).toMatch(/daemon-c/);
    expect(hint.textContent).toMatch(/daemon-a/);
  });

  it('hides the offline-fallback hint when the last-used daemon is still online', () => {
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={MERGED_DAEMONS}
        initialDaemon="daemon-b"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.queryByRole('status')).toBeNull();
  });

  describe('global AI backend (RFC 0041)', () => {
    const WITH_GLOBAL: MoveIssueToDoingDaemonOption[] = [{
      ...SINGLE_DAEMON[0],
      globalBackends: [
        { host: 'gpu-box', backend: 'codex', disabledReason: null },
        { host: 'laptop', backend: 'claude', disabledReason: 'laptop is offline' },
      ],
    }];

    it('offers global backends in the backend picker and confirms with the picked one', async () => {
      const onConfirm = vi.fn();
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={WITH_GLOBAL}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      );

      const select = screen.getByLabelText('Backend') as HTMLSelectElement;
      const offline = screen.getByRole('option', { name: 'claude @ laptop — laptop is offline' });
      expect(offline).toBeDisabled();
      fireEvent.change(select, { target: { value: (screen.getByRole('option', { name: 'codex @ gpu-box' }) as HTMLOptionElement).value } });
      expect(screen.getByText(/AI runs on gpu-box and works on daemon-a/)).toBeInTheDocument();
      // A global backend runs no agent group.
      expect(screen.queryByText(/Agents/)).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Move To Doing' }));
      });

      expect(onConfirm).toHaveBeenCalledWith({
        backendType: 'codex',
        daemonHost: 'daemon-a',
        projectId: 'project-a',
        globalBackend: { host: 'gpu-box', backend: 'codex' },
      });
    });
  });

  describe('agents (RFC 0033)', () => {
    const openAgentsSection = () => {
      const details = screen.getByText('Agents (optional)').closest('details')!;
      expect(details).not.toHaveAttribute('open');
      details.open = true;
      fireEvent(details, new Event('toggle'));
    };

    it('loads the registry only when opened and confirms with a worker + reviewer group', async () => {
      apiGetMock.mockReset().mockResolvedValue({
        agents: [
          { name: 'feature-dev', description: null, backend: 'codex' },
          { name: 'code-reviewer', description: null, backend: null },
        ],
      });
      const onConfirm = vi.fn();
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={SINGLE_DAEMON}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      );

      expect(apiGetMock).not.toHaveBeenCalled();
      openAgentsSection();
      expect(apiGetMock).toHaveBeenCalledWith('/projects/project-a/agents');

      fireEvent.change(await screen.findByLabelText('Worker agent'), { target: { value: 'feature-dev' } });
      // The worker's registry default backend is applied.
      expect(screen.getByLabelText('Backend')).toHaveValue('codex');
      fireEvent.click(screen.getByRole('button', { name: '+ Add reviewer' }));
      fireEvent.change(screen.getByLabelText('Reviewer 1 agent'), { target: { value: 'code-reviewer' } });
      fireEvent.change(screen.getByLabelText('Reviewer 1 backend'), { target: { value: 'claude' } });
      expect(screen.getByText('Agents: feature-dev, code-reviewer')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Move To Doing' }));
      });

      expect(onConfirm).toHaveBeenCalledWith({
        backendType: 'codex',
        daemonHost: 'daemon-a',
        projectId: 'project-a',
        agents: [{ name: 'feature-dev' }, { name: 'code-reviewer', backend: 'claude' }],
      });
    });

    it('loads the registry of the picked daemon\'s sibling project in a merged group', async () => {
      apiGetMock.mockReset().mockResolvedValue({ agents: [] });
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={MERGED_DAEMONS}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      fireEvent.change(screen.getByLabelText('Daemon'), { target: { value: 'daemon-b' } });
      openAgentsSection();

      await screen.findByText(/No agents registered for this project/);
      expect(apiGetMock).toHaveBeenCalledTimes(1);
      expect(apiGetMock).toHaveBeenCalledWith('/projects/project-b/agents');
    });

    it('blocks confirm while the picked agents are unvalidated after a daemon switch', async () => {
      apiGetMock.mockReset()
        .mockResolvedValueOnce({ agents: [{ name: 'feature-dev', description: null, backend: null }] })
        .mockReturnValueOnce(new Promise(() => {}));
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={MERGED_DAEMONS}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      openAgentsSection();
      fireEvent.change(await screen.findByLabelText('Worker agent'), { target: { value: 'feature-dev' } });
      const confirm = screen.getByRole('button', { name: 'Move To Doing' });
      expect(confirm).toBeEnabled();

      fireEvent.change(screen.getByLabelText('Daemon'), { target: { value: 'daemon-b' } });

      expect(apiGetMock).toHaveBeenLastCalledWith('/projects/project-b/agents');
      expect(screen.getByText('Loading registered agents…')).toBeInTheDocument();
      expect(screen.getByText('Agents: feature-dev')).toBeInTheDocument();
      expect(confirm).toBeDisabled();
    });

    it('shows the registry guidance when the project has no agents', async () => {
      apiGetMock.mockReset().mockResolvedValue({ agents: [] });
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={SINGLE_DAEMON}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      openAgentsSection();

      expect(await screen.findByText(/No agents registered for this project/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Worker agent')).toBeNull();
    });
  });
});
