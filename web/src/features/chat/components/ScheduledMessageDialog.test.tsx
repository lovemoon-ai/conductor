import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledMessageDialog } from './ScheduledMessageDialog';

const apiPostMock = vi.fn().mockResolvedValue({ id: 'sched-1' });
const pushToastMock = vi.fn();

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
    post: apiPostMock,
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
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

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
});
