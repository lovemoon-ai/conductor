import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '@/shared/types';

const toggleMessageSpeech = vi.fn();
vi.mock('../voice/message-speaker', async () => {
  const { create } = await import('zustand');
  const useMessageSpeakerStore = create(() => ({ messageId: null as string | null, status: 'idle' as 'idle' | 'loading' | 'playing', error: '' }));
  return { toggleMessageSpeech: (...args: unknown[]) => toggleMessageSpeech(...args), useMessageSpeakerStore };
});
vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const { MessageBubble } = await import('./MessageBubble');
const { useMessageSpeakerStore } = await import('../voice/message-speaker');

const message = {
  id: 'msg-1',
  role: 'assistant',
  content: 'hello from conductor',
  createdAt: '2026-07-23T00:00:00.000Z',
} as unknown as Message;

describe('MessageBubble read-aloud action', () => {
  it('reads the message aloud from its toolbar, outside voice mode, and shows Stop while playing', async () => {
    render(<MessageBubble message={message} />);
    fireEvent.doubleClick(screen.getByRole('button', { expanded: false }));
    const button = await screen.findByRole('button', { name: 'Read message aloud' });

    fireEvent.click(button);
    expect(toggleMessageSpeech).toHaveBeenCalledWith('msg-1', 'hello from conductor');

    act(() => useMessageSpeakerStore.setState({ messageId: 'msg-1', status: 'playing' }));
    expect(screen.getByTestId('message-bubble-speak-button')).toHaveAttribute('data-speak-status', 'playing');
    expect(screen.getByRole('button', { name: 'Stop reading aloud' })).toBeInTheDocument();

    act(() => useMessageSpeakerStore.setState({ messageId: 'other', status: 'playing' }));
    expect(screen.getByRole('button', { name: 'Read message aloud' })).toBeInTheDocument();
  });
});
