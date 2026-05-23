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
  it('shows the daemon picker even when only one daemon is available so the user sees where the task will spawn', () => {
    render(
      <MoveIssueToDoingDialog
        open
        daemonOptions={SINGLE_DAEMON}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    const daemonSelect = screen.getByLabelText('Daemon');
    expect(daemonSelect).toHaveValue('daemon-a');
    // Disabled because there is nothing else to switch to — but it remains
    // visible so the affordance "you are picking a daemon" is preserved.
    expect(daemonSelect).toBeDisabled();
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
});
