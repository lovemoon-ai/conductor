import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AchievedTaskSettingsCard } from './AchievedTaskSettingsCard';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => apiMocks,
}));

describe('AchievedTaskSettingsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.get.mockResolvedValue({
      tasks: [],
      total: 87,
      page: 1,
      pageSize: 1,
      totalPages: 87,
    });
  });

  it('shows only the archive count and a link to the secondary page', async () => {
    render(<AchievedTaskSettingsCard />);

    expect(screen.getByRole('heading', { name: 'Achieved tasks' })).toBeInTheDocument();
    expect(await screen.findByText('87 archived tasks')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByTestId('achieved-tasks-list')).toBeNull();
    expect(screen.getByRole('link', { name: 'View tasks' })).toHaveAttribute(
      'href',
      '/app/settings/achieved-tasks',
    );
    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('/tasks/achieved?page=1&limit=1');
    });
  });
});
