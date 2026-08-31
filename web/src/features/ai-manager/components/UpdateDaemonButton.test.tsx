import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateDaemonButton } from './UpdateDaemonButton';

const confirmMock = vi.fn();
const pushToastMock = vi.fn();
const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('@/components/common/FeedbackProvider', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({ get: apiGetMock, post: apiPostMock }),
}));

describe('UpdateDaemonButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    apiGetMock.mockResolvedValue({ runId: null, status: 'idle' });
    apiPostMock.mockResolvedValue({ runId: 'run-1', status: 'running', message: 'Update starting' });
  });

  it('renders nothing when the daemon does not support built-in update', () => {
    const { container } = render(<UpdateDaemonButton agentHost="daemon-a" supported={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('confirms, then starts the update', async () => {
    render(<UpdateDaemonButton agentHost="daemon-a" supported />);

    fireEvent.click(screen.getByLabelText('Update daemon on daemon-a'));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Update daemon on daemon-a?', confirmLabel: 'Update' }),
      );
      expect(apiPostMock).toHaveBeenCalledWith('/agents/daemon-a/update', {});
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Update started', variant: 'success' }),
    );
  });

  it('does not start the update when the confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false);
    render(<UpdateDaemonButton agentHost="daemon-a" supported />);

    fireEvent.click(screen.getByLabelText('Update daemon on daemon-a'));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('polls to completion and reports the outcome', async () => {
    const onFinished = vi.fn();
    apiGetMock
      .mockResolvedValueOnce({ runId: null, status: 'idle' })
      .mockResolvedValue({
        runId: 'run-1',
        status: 'completed',
        message: 'Updated 1.0.0 → 1.1.0 and restarted the daemon',
      });

    render(<UpdateDaemonButton agentHost="daemon-a" supported onFinished={onFinished} />);
    fireEvent.click(screen.getByLabelText('Update daemon on daemon-a'));

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Daemon updated', variant: 'success' }),
      );
    });
    expect(onFinished).toHaveBeenCalled();
    expect(await screen.findByText(/Updated 1.0.0/)).toBeInTheDocument();
  });

  it('reports a failed update with the daemon-side reason', async () => {
    apiGetMock.mockResolvedValueOnce({ runId: null, status: 'idle' }).mockResolvedValue({
      runId: 'run-1',
      status: 'failed',
      message: 'Update failed',
      error: 'install failed (exit 1): ENOTEMPTY',
    });

    render(<UpdateDaemonButton agentHost="daemon-a" supported />);
    fireEvent.click(screen.getByLabelText('Update daemon on daemon-a'));

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Daemon update failed', variant: 'error' }),
      );
    });
    expect(await screen.findByText(/ENOTEMPTY/)).toBeInTheDocument();
  });

  it('shows an update that was already running when the panel mounted', async () => {
    apiGetMock.mockResolvedValue({
      runId: 'run-1',
      status: 'running',
      message: 'Installing @love-moon/conductor-cli@1.1.0 via npm',
    });

    render(<UpdateDaemonButton agentHost="daemon-a" supported />);

    expect(await screen.findByText(/Installing @love-moon/)).toBeInTheDocument();
    expect(screen.getByLabelText('Update daemon on daemon-a')).toBeDisabled();
  });

  it('surfaces a failure to start', async () => {
    apiPostMock.mockRejectedValue(new Error('daemon does not support built-in update'));
    render(<UpdateDaemonButton agentHost="daemon-a" supported />);

    fireEvent.click(screen.getByLabelText('Update daemon on daemon-a'));

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Failed to start update', variant: 'error' }),
      );
    });
  });
});
