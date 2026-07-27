import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadOnlyTranscript } from './ReadOnlyTranscript';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => apiMocks,
}));

describe('ReadOnlyTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.get.mockResolvedValue([
      {
        id: 'message-user',
        taskId: 'task-1',
        role: 'user',
        content: 'First archived message',
      },
      {
        id: 'message-agent',
        taskId: 'task-1',
        role: 'sdk',
        content: 'Second archived message',
      },
    ]);
  });

  it('renders archived messages without Agent or You role labels', async () => {
    render(<ReadOnlyTranscript taskId="task-1" />);

    expect(await screen.findByText('First archived message')).toBeInTheDocument();
    expect(screen.getByText('Second archived message')).toBeInTheDocument();
    expect(screen.queryByText('Agent')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
    expect(apiMocks.get).toHaveBeenCalledWith('/tasks/task-1/messages');
  });
});
