import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

const makeMessage = (overrides: Partial<Parameters<typeof MessageBubble>[0]['message']> = {}) => ({
  id: 'message-1',
  taskId: 'task-1',
  role: 'sdk' as const,
  content: 'hello world',
  createdAt: '2026-03-07T12:00:00.000Z',
  ...overrides,
});

describe('MessageBubble', () => {
  it('renders user messages in the shared full-width column with distinct color and right-side corner', () => {
    const { container } = render(<MessageBubble message={makeMessage({ role: 'user', content: 'user message' })} />);

    const row = container.firstElementChild as HTMLElement;
    const column = row.firstElementChild as HTMLElement;
    const wrapper = column.firstElementChild as HTMLElement;
    const bubble = wrapper.querySelector('[role="button"]') as HTMLElement;

    expect(row).toHaveClass('w-full');
    expect(column).toHaveClass('mx-auto', 'w-full', 'max-w-5xl');
    expect(wrapper).toHaveClass('relative', 'overflow-visible', 'rounded-2xl');
    expect(bubble).toHaveClass(
      'w-full',
      'rounded-2xl',
      'border',
      'webapp-gradient-bg',
      'border-transparent',
      'text-white',
      'rounded-br-md',
    );
    expect(screen.getByText('user message')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
    expect(screen.queryByText('You')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument();

    fireEvent.click(bubble);

    expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument();

    fireEvent.doubleClick(bubble);

    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    expect(screen.queryByText('Copy')).not.toBeInTheDocument();
  });

  it('renders ai messages in the same shared full-width column with left-side corner', () => {
    const { container } = render(<MessageBubble message={makeMessage({ role: 'assistant', content: 'ai message' })} />);

    const row = container.firstElementChild as HTMLElement;
    const column = row.firstElementChild as HTMLElement;
    const wrapper = column.firstElementChild as HTMLElement;
    const bubble = wrapper.querySelector('[role="button"]') as HTMLElement;

    expect(row).toHaveClass('w-full');
    expect(column).toHaveClass('mx-auto', 'w-full', 'max-w-5xl');
    expect(bubble).toHaveClass('w-full', 'rounded-2xl', 'border', 'bg-paper', 'border-border', 'rounded-bl-md', 'shadow-sm');
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('ai message');
    expect(screen.queryByText('Conductor')).not.toBeInTheDocument();
    expect(wrapper).toHaveClass('pt-2');
    expect(wrapper.firstElementChild).toHaveClass('left-4', '-top-1', 'h-2', 'items-center', 'leading-none', 'opacity-0', 'group-hover/message:opacity-100');
  });
});
