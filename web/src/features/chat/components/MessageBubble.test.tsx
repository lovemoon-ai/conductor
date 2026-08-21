import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        media: '',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('renders user messages in the shared full-width column with distinct color and right-side corner', () => {
    const { container } = render(<MessageBubble message={makeMessage({ role: 'user', content: 'user message' })} />);

    const row = container.firstElementChild as HTMLElement;
    const column = row.firstElementChild as HTMLElement;
    const wrapper = column.firstElementChild as HTMLElement;
    const bubble = wrapper.querySelector('[role="button"]') as HTMLElement;

    expect(row).toHaveClass('w-full');
    expect(column).toHaveClass('w-full');
    expect(column).not.toHaveClass('max-w-5xl');
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
    // Each toolbar button now carries a short single-word caption beneath it.
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('calls onResend with the current message from the double-click toolbar', () => {
    const onResend = vi.fn();
    const { container } = render(
      <MessageBubble
        message={makeMessage({ role: 'user', content: 'repeat this' })}
        onResend={onResend}
      />,
    );

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(bubble);

    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resend message' }));

    expect(onResend).toHaveBeenCalledWith('repeat this');
    expect(screen.queryByRole('button', { name: 'Resend message' })).not.toBeInTheDocument();
  });

  it('calls onSchedule with the current message from the double-click toolbar', () => {
    const onSchedule = vi.fn();
    const message = makeMessage({ role: 'user', content: 'send this later' });
    const { container } = render(
      <MessageBubble
        message={message}
        onSchedule={onSchedule}
      />,
    );

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(bubble);
    fireEvent.click(screen.getByTestId('message-bubble-schedule-button'));

    expect(onSchedule).toHaveBeenCalledWith(message);
    expect(screen.queryByTestId('message-bubble-schedule-button')).not.toBeInTheDocument();
  });

  it('calls onRestart from the message action sheet', () => {
    const onRestart = vi.fn();
    const { container } = render(
      <MessageBubble
        message={makeMessage({ role: 'assistant', content: 'restart this task' })}
        onRestart={onRestart}
        restartEnabled
      />,
    );

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(bubble);
    expect(screen.getByRole('button', { name: 'Restart AI task' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('message-bubble-restart-button'));

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('message-bubble-restart-button')).not.toBeInTheDocument();
  });

  it('disables the restart action while a restart is already pending', () => {
    const onRestart = vi.fn();
    const { container } = render(
      <MessageBubble
        message={makeMessage({ role: 'assistant', content: 'restart this task' })}
        onRestart={onRestart}
        restartEnabled
        restartPending
      />,
    );

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(bubble);
    const restartButton = screen.getByTestId('message-bubble-restart-button');

    expect(restartButton).toBeDisabled();
    fireEvent.click(restartButton);
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('calls onInterrupt from the message action sheet', () => {
    const onInterrupt = vi.fn();
    const { container } = render(
      <MessageBubble
        message={makeMessage({ role: 'assistant', content: 'ai reply' })}
        onInterrupt={onInterrupt}
        interruptEnabled
      />,
    );

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(bubble);
    expect(screen.getByRole('button', { name: 'Interrupt current reply' })).toBeInTheDocument();
    expect(screen.queryByText('中断')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('message-bubble-interrupt-button'));

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('message-bubble-interrupt-button')).not.toBeInTheDocument();
  });

  it('disables the message interrupt action when no reply can be interrupted', () => {
    const onInterrupt = vi.fn();
    const { container } = render(
      <MessageBubble
        message={makeMessage({ role: 'assistant', content: 'ai reply' })}
        onInterrupt={onInterrupt}
      />,
    );

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.doubleClick(bubble);
    const interruptButton = screen.getByTestId('message-bubble-interrupt-button');

    expect(interruptButton).toBeDisabled();
    fireEvent.click(interruptButton);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('opens the message action sheet on double tap', () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({ role: 'assistant', content: 'ai reply' })}
        onInterrupt={() => {}}
        interruptEnabled
      />,
    );

    const bubble = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.touchEnd(bubble);
    fireEvent.touchEnd(bubble);

    expect(screen.getByTestId('message-bubble-interrupt-button')).toBeInTheDocument();
  });

  it('renders ai messages in the same shared full-width column with left-side corner', () => {
    const { container } = render(<MessageBubble message={makeMessage({ role: 'assistant', content: 'ai message' })} />);

    const row = container.firstElementChild as HTMLElement;
    const column = row.firstElementChild as HTMLElement;
    const wrapper = column.firstElementChild as HTMLElement;
    const bubble = wrapper.querySelector('[role="button"]') as HTMLElement;

    expect(row).toHaveClass('w-full');
    expect(column).toHaveClass('w-full');
    expect(column).not.toHaveClass('max-w-5xl');
    expect(bubble).toHaveClass('w-full', 'rounded-2xl', 'border', 'bg-paper', 'border-border', 'rounded-bl-md', 'shadow-sm');
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('ai message');
    expect(screen.queryByText('Conductor')).not.toBeInTheDocument();
    expect(wrapper).toHaveClass('pt-2');
    expect(wrapper.firstElementChild).toHaveClass('left-4', '-top-1', 'h-2', 'items-center', 'leading-none', 'opacity-0', 'group-hover/message:opacity-100');
  });

  it('shows the timestamp on single tap for mobile-style pointers', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(hover: none), (pointer: coarse)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const { container } = render(<MessageBubble message={makeMessage({ role: 'assistant', content: 'ai message' })} />);
    const wrapper = container.querySelector('.group\\/message') as HTMLElement;
    const bubble = wrapper.querySelector('[role="button"]') as HTMLElement;
    const timestamp = wrapper.firstElementChild as HTMLElement;

    expect(timestamp).toHaveClass('opacity-0');

    fireEvent.click(bubble);

    expect(timestamp).toHaveClass('opacity-100');

    fireEvent.click(bubble);

    expect(timestamp).toHaveClass('opacity-0');
  });

  it('falls back to a placeholder when an expired image body can no longer be loaded', () => {
    render(
      <MessageBubble
        message={makeMessage({
          role: 'user',
          attachments: [{
            id: 'att-1',
            name: 'shot.png',
            kind: 'image',
            mimeType: 'image/png',
            sizeBytes: 1024,
            downloadUrl: '/api/tasks/task-1/attachments/att-1',
          }],
        } as never)}
      />,
    );

    const image = screen.getByAltText('shot.png');
    expect(screen.queryByText('Preview no longer available')).toBeNull();

    // The retention sweep released the bytes, so the request 404s.
    fireEvent.error(image);

    expect(screen.getByText('Preview no longer available')).toBeInTheDocument();
    expect(screen.queryByAltText('shot.png')).toBeNull();
    // Metadata stays visible so history still shows what was sent.
    expect(screen.getByText('shot.png')).toBeInTheDocument();
  });

  it('marks a released file attachment instead of opening a dead download', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MessageBubble
        message={makeMessage({
          role: 'user',
          attachments: [{
            id: 'att-1',
            name: 'spec.md',
            kind: 'file',
            mimeType: 'text/markdown',
            sizeBytes: 2048,
            downloadUrl: '/api/tasks/task-1/attachments/att-1',
          }],
        } as never)}
      />,
    );

    fireEvent.click(screen.getByText('spec.md'));
    await screen.findByText('No longer available');
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/attachments/att-1', { method: 'HEAD' });

    vi.unstubAllGlobals();
  });

  it('leaves a file download alone when the probe cannot prove it is gone', async () => {
    // A blocked or offline probe must not disable a working download.
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MessageBubble
        message={makeMessage({
          role: 'user',
          attachments: [{
            id: 'att-1',
            name: 'spec.md',
            kind: 'file',
            mimeType: 'text/markdown',
            sizeBytes: 2048,
            downloadUrl: '/api/tasks/task-1/attachments/att-1',
          }],
        } as never)}
      />,
    );

    fireEvent.click(screen.getByText('spec.md'));
    await Promise.resolve();
    expect(screen.queryByText('No longer available')).toBeNull();
    expect(screen.getByText('spec.md').closest('a')).toHaveAttribute(
      'href',
      '/api/tasks/task-1/attachments/att-1',
    );

    vi.unstubAllGlobals();
  });
});
