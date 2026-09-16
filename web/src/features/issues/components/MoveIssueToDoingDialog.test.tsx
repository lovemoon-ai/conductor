import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MoveIssueToDoingDialog, type MoveIssueToDoingDaemonOption } from './MoveIssueToDoingDialog';

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

  describe('workspace on another daemon (RFC 0038)', () => {
    const REMOTE_CAPABLE: MoveIssueToDoingDaemonOption[] = MERGED_DAEMONS.map((option) => ({
      ...option,
      remoteWorktreeHosts: MERGED_DAEMONS.filter((other) => other.host !== option.host).map((other) => other.host),
    }));

    it('is hidden when no other daemon can host the worktree', () => {
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={MERGED_DAEMONS}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      expect(screen.queryByLabelText('Workspace on another daemon')).toBeNull();
    });

    it('starts collapsed on the same daemon and confirms with the picked host', async () => {
      const onConfirm = vi.fn();
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={REMOTE_CAPABLE}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      );

      const details = screen.getByText('Workspace on another daemon').closest('details');
      expect(details).not.toHaveAttribute('open');
      const select = screen.getByLabelText('Workspace on another daemon');
      expect(select).toHaveValue('');
      // Never offers the daemon that runs the AI.
      expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual(['', 'daemon-b']);

      fireEvent.change(select, { target: { value: 'daemon-b' } });
      expect(screen.getByText('Workspace on another daemon: daemon-b')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Move To Doing' }));
      });

      expect(onConfirm).toHaveBeenCalledWith({
        backendType: 'claude',
        daemonHost: 'daemon-a',
        projectId: 'project-a',
        remoteWorktreeHost: 'daemon-b',
      });
    });

    it('keeps a pick whose daemon went offline and blocks confirm until another workspace is chosen', async () => {
      const onConfirm = vi.fn();
      const { rerender } = render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={REMOTE_CAPABLE}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      );

      fireEvent.change(screen.getByLabelText('Workspace on another daemon'), { target: { value: 'daemon-b' } });
      rerender(
        <MoveIssueToDoingDialog
          open
          daemonOptions={REMOTE_CAPABLE.slice(0, 1)}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      );

      expect(screen.getByRole('alert').textContent).toMatch(/daemon-b is no longer available/);
      expect(screen.getByLabelText('Workspace on another daemon')).toHaveValue('daemon-b');
      const confirm = screen.getByRole('button', { name: 'Move To Doing' });
      expect(confirm).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Workspace on another daemon'), { target: { value: '' } });

      expect(screen.queryByRole('alert')).toBeNull();
      // With nothing left to pick, the section disappears again.
      expect(screen.queryByLabelText('Workspace on another daemon')).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Move To Doing' }));
      });
      expect(onConfirm).toHaveBeenCalledWith({
        backendType: 'claude',
        daemonHost: 'daemon-a',
        projectId: 'project-a',
      });
    });

    it('offers only the workspace hosts paired with the selected AI daemon', () => {
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={[
            { host: 'daemon-a', projectId: 'project-a', supportedBackends: ['claude'], remoteWorktreeHosts: ['daemon-c'] },
            { host: 'daemon-b', projectId: 'project-b', supportedBackends: ['claude'], remoteWorktreeHosts: [] },
            { host: 'daemon-c', projectId: 'project-c', supportedBackends: ['claude'], remoteWorktreeHosts: ['daemon-a'] },
          ]}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      const select = screen.getByLabelText('Workspace on another daemon') as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'daemon-c']);

      fireEvent.change(screen.getByLabelText('Daemon'), { target: { value: 'daemon-b' } });

      expect(screen.queryByLabelText('Workspace on another daemon')).toBeNull();
    });

    it('names the offline AI daemon when the AI falls back onto the chosen workspace daemon', () => {
      const { rerender } = render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={REMOTE_CAPABLE}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      fireEvent.change(screen.getByLabelText('Daemon'), { target: { value: 'daemon-b' } });
      fireEvent.change(screen.getByLabelText('Workspace on another daemon'), { target: { value: 'daemon-a' } });
      // daemon-b (the AI) disconnects; the AI falls back to daemon-a.
      rerender(
        <MoveIssueToDoingDialog
          open
          daemonOptions={REMOTE_CAPABLE.slice(0, 1)}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      const alert = screen.getByRole('alert').textContent ?? '';
      expect(alert).toMatch(/daemon-b went offline, so the AI now runs on daemon-a, your chosen workspace/);
      expect(alert).not.toMatch(/daemon-a is no longer available/);
      expect(screen.getByRole('button', { name: 'Move To Doing' })).toBeDisabled();
    });

    it('resets the choice when the AI daemon changes', () => {
      render(
        <MoveIssueToDoingDialog
          open
          daemonOptions={REMOTE_CAPABLE}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      );

      fireEvent.change(screen.getByLabelText('Workspace on another daemon'), { target: { value: 'daemon-b' } });
      fireEvent.change(screen.getByLabelText('Daemon'), { target: { value: 'daemon-b' } });

      const select = screen.getByLabelText('Workspace on another daemon') as HTMLSelectElement;
      expect(select).toHaveValue('');
      expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'daemon-a']);
    });
  });
});
