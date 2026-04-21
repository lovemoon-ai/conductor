import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TaskStatusBadge } from './TaskStatusBadge';

describe('TaskStatusBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows elapsed seconds for killing tasks and ticks once per second', () => {
    vi.setSystemTime(new Date('2026-04-20T00:00:12.000Z'));

    render(
      <TaskStatusBadge
        status="killing"
        statusStartedAt="2026-04-20T00:00:00.000Z"
        timeoutMs={60_000}
      />,
    );

    expect(screen.getByText('killing 12s')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText('killing 13s')).toBeInTheDocument();
  });

  it('marks killing as timed out after the configured timeout', () => {
    vi.setSystemTime(new Date('2026-04-20T00:01:10.000Z'));

    render(
      <TaskStatusBadge
        status="killing"
        statusStartedAt="2026-04-20T00:00:00.000Z"
        timeoutMs={60_000}
      />,
    );

    const badge = screen.getByText('killing 60s timeout');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'Killing timed out after 60s');
  });
});
