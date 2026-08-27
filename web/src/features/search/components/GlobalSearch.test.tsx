import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from './GlobalSearch';

const apiMocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => apiMocks,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : ''}>{children}</a>
  ),
}));

const typeQuery = (value: string) =>
  fireEvent.change(screen.getByLabelText('Search all conversations'), {
    target: { value },
  });

describe('GlobalSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries the search API and renders task-grouped, highlighted hits', async () => {
    apiMocks.get.mockResolvedValue({
      query: 'api',
      backend: 'fts',
      hits: [
        {
          taskId: 't1',
          taskTitle: 'Ship the API',
          messageId: 'm1',
          role: 'assistant',
          snippet: 'the [api] contract',
          createdAt: '2024-05-01T00:00:00.000Z',
        },
        {
          taskId: 't1',
          taskTitle: 'Ship the API',
          messageId: 'm2',
          role: 'user',
          snippet: 'check [api]',
          createdAt: '2024-05-02T00:00:00.000Z',
        },
      ],
    });

    render(<GlobalSearch />);
    typeQuery('api');

    await waitFor(() =>
      expect(apiMocks.get).toHaveBeenCalledWith(
        expect.stringContaining('/search?q=api'),
      ),
    );
    // Grouped once by task, with both message hits under it.
    const taskLink = await screen.findByText('Ship the API');
    expect(taskLink).toHaveAttribute('href', '/app/tasks/t1');
    // Both snippets highlight the matched term.
    expect(screen.getAllByText('api')).toHaveLength(2);
  });

  it('shows an empty state when there are no matches', async () => {
    apiMocks.get.mockResolvedValue({ query: 'zzz', backend: 'fts', hits: [] });

    render(<GlobalSearch />);
    typeQuery('zzz');

    await waitFor(() => expect(screen.getByText(/No matches/)).toBeInTheDocument());
  });

  it('does not query the API for a blank query', async () => {
    render(<GlobalSearch />);
    typeQuery('   ');

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(apiMocks.get).not.toHaveBeenCalled();
  });
});
