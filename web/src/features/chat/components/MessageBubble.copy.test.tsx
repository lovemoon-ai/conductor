import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import type { Message } from '@/shared/types';

const copyToClipboardMock = vi.fn();
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: (value: string) => copyToClipboardMock(value),
}));

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const message = {
  id: 'msg-1',
  role: 'assistant',
  content: 'hello from conductor',
  createdAt: '2026-07-23T00:00:00.000Z',
} as unknown as Message;

// The action toolbar is revealed by double-clicking the bubble.
const openToolbar = () => {
  fireEvent.doubleClick(screen.getByRole('button', { expanded: false }));
  return screen.findByRole('button', { name: 'Copy message' });
};

describe('MessageBubble copy action', () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset().mockResolvedValue(true);
  });

  it('copies the message content and dismisses the toolbar on success', async () => {
    render(<MessageBubble message={message} />);

    fireEvent.click(await openToolbar());

    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalledWith('hello from conductor'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull());
  });

  it('keeps the toolbar open when the copy fails so the action can be retried', async () => {
    copyToClipboardMock.mockResolvedValue(false);
    render(<MessageBubble message={message} />);

    fireEvent.click(await openToolbar());

    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
  });
});
