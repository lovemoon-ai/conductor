import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledMessageDialog } from './ScheduledMessageDialog';

const apiPostMock = vi.fn().mockResolvedValue({ id: 'sched-1' });
const apiGetMock = vi.fn().mockResolvedValue({ schedules: [] });
const apiPatchMock = vi.fn().mockResolvedValue({ id: 'sched-1' });
const apiDeleteMock = vi.fn().mockResolvedValue(undefined);
const pushToastMock = vi.fn();

const activeSchedule = {
  id: 'sched-1',
  taskId: 'task-1',
  content: 'nightly deploy check',
  kind: 'interval',
  condition: 'ai_idle',
  intervalMs: 2 * 60 * 60 * 1000,
  status: 'active',
  nextRunAt: '2026-06-07T12:00:00.000Z',
  runCount: 1,
  skipCount: 0,
  failureCount: 0,
  maxRuns: 5,
  maxSkips: null,
  stopAt: null,
  stopWhenTaskNotRunning: true,
  lastRunAt: '2026-06-07T10:00:00.000Z',
  lastError: null,
  createdAt: '2026-06-07T09:00:00.000Z',
};

const finishedSchedule = {
  ...activeSchedule,
  id: 'sched-2',
  content: 'one-off reminder',
  kind: 'once_at',
  condition: 'none',
  intervalMs: null,
  status: 'completed',
  maxRuns: null,
};

vi.mock('@/components/common/Dialog', () => ({
  Dialog: ({
    open,
    children,
    title,
  }: {
    open: boolean;
    children: React.ReactNode;
    title: string;
  }) => (open ? <div role="dialog" aria-label={title}>{children}</div> : null),
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: apiDeleteMock,
  }),
}));

const message = {
  id: 'msg-1',
  taskId: 'task-1',
  role: 'user' as const,
  content: 'send this later',
  createdAt: '2026-06-07T10:00:00.000Z',
};

describe('ScheduledMessageDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockResolvedValue({ schedules: [] });
    apiPostMock.mockResolvedValue({ id: 'sched-1' });
    apiPatchMock.mockResolvedValue({ id: 'sched-1' });
    apiDeleteMock.mockResolvedValue(undefined);
  });

  it('creates a delayed scheduled message from the selected message', async () => {
    const onClose = vi.fn();
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText('After'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Schedule' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/scheduled-messages', {
        content: 'send this later',
        sourceMessageId: 'msg-1',
        schedule: {
          mode: 'delay',
          amount: 15,
          unit: 'minute',
        },
      });
    });
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Scheduled message created',
      variant: 'success',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits edited message content from the schedule dialog', async () => {
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Message content'), {
      target: { value: 'edited scheduled content' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Schedule' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/scheduled-messages', expect.objectContaining({
        content: 'edited scheduled content',
        sourceMessageId: 'msg-1',
      }));
    });
  });

  it('creates an idle-gated interval schedule with stop conditions', async () => {
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'If Idle' }));
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.change(screen.getByDisplayValue('3'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Schedule' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/scheduled-messages', expect.objectContaining({
        schedule: expect.objectContaining({
          mode: 'interval',
          every: 2,
          unit: 'hour',
          condition: 'ai_idle',
          stop: expect.objectContaining({
            maxRuns: 4,
            stopWhenTaskNotRunning: true,
          }),
        }),
      }));
    });
  });

  it('keeps the confirmation action in a fixed footer for long schedule forms', () => {
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'If Idle' }));

    const confirmButton = screen.getByRole('button', { name: 'Confirm Schedule' });
    expect(confirmButton.parentElement).toHaveClass('shrink-0', 'border-t');
  });

  it('uses accent contrast for the active mode and confirmation buttons', () => {
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));

    const repeatButton = screen.getByRole('button', { name: 'Repeat' });
    const confirmButton = screen.getByRole('button', { name: 'Confirm Schedule' });

    expect(repeatButton).toHaveClass('webapp-gradient-bg', 'text-white');
    expect(repeatButton).not.toHaveClass('bg-ink');
    expect(confirmButton).toHaveClass('webapp-gradient-bg', 'text-white');
    expect(confirmButton).not.toHaveClass('bg-ink');
  });
  it('lists existing schedules and filters them by status and keyword', async () => {
    apiGetMock.mockResolvedValue({ schedules: [activeSchedule] });
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Manage/ }));

    await waitFor(() => {
      expect(screen.getByText('nightly deploy check')).toBeInTheDocument();
    });
    expect(screen.getByText('Every 2h, only when AI is idle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/tasks/task-1/scheduled-messages?status=active');
    });

    fireEvent.change(screen.getByLabelText('Search scheduled messages'), {
      target: { value: 'deploy' },
    });
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith(
        '/tasks/task-1/scheduled-messages?status=active&q=deploy',
      );
    });
  });

  it('edits an existing schedule with a PATCH seeded from its current plan', async () => {
    apiGetMock.mockResolvedValue({ schedules: [activeSchedule] });
    const onClose = vi.fn();
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Manage/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // The form is seeded from the edited row, not from the picked message.
    expect(screen.getByLabelText('Message content')).toHaveValue('nightly deploy check');
    expect(screen.getByLabelText('Every')).toHaveValue(2);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith(
        '/tasks/task-1/scheduled-messages/sched-1',
        expect.objectContaining({
          content: 'nightly deploy check',
          schedule: expect.objectContaining({
            mode: 'interval',
            every: 2,
            unit: 'hour',
            condition: 'ai_idle',
            stop: expect.objectContaining({ maxRuns: 5, stopWhenTaskNotRunning: true }),
          }),
        }),
      );
    });
    // Editing returns to the list instead of closing the whole dialog.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels an active schedule and deletes a finished one', async () => {
    apiGetMock.mockResolvedValue({ schedules: [activeSchedule, finishedSchedule] });
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Manage/ }));
    await waitFor(() => {
      expect(screen.getAllByTestId('scheduled-message-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(apiDeleteMock).toHaveBeenCalledWith('/tasks/task-1/scheduled-messages/sched-1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(apiDeleteMock).toHaveBeenCalledWith('/tasks/task-1/scheduled-messages/sched-2');
    });
    // A finished row offers deletion only -- there is nothing left to edit.
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
  });

  it('opens on the management list when the composer draft is empty', async () => {
    apiGetMock.mockResolvedValue({ schedules: [activeSchedule] });
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={{ id: '', taskId: 'task-1', role: 'user', content: '' }}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('nightly deploy check')).toBeInTheDocument();
    });
  });

  it('offers a Sent filter for the terminal state of a one-off send', async () => {
    apiGetMock.mockResolvedValue({ schedules: [] });
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Manage/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sent' }));

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/tasks/task-1/scheduled-messages?status=sent');
    });
  });

  it('keeps an in-flight row listed and surfaces the conflict when removal is refused', async () => {
    apiGetMock.mockResolvedValue({ schedules: [activeSchedule] });
    apiDeleteMock.mockRejectedValue(
      new Error('This scheduled message is being sent right now. Try again in a moment.'),
    );
    render(
      <ScheduledMessageDialog
        open
        taskId="task-1"
        message={message}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Manage/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(
        screen.getByText('This scheduled message is being sent right now. Try again in a moment.'),
      ).toBeInTheDocument();
    });
    // A refused removal must not optimistically drop the row.
    expect(screen.getAllByTestId('scheduled-message-row')).toHaveLength(1);
  });
});
