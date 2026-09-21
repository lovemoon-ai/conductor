import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getApiClient } from '@/shared/api/client';
import { useChatStore } from './store';
import type { Message } from '@/shared/types';
import { MessageBubble } from './components/MessageBubble';
import { beginReplyTiming, observeReplyTiming } from './reply-latency';

const reply = (replyTo: string, overrides: Partial<Message> = {}): Message => ({
  id: `reply-${replyTo}`, taskId: 'task', role: 'sdk', content: 'Ready.',
  metadata: { reply_to: replyTo }, createdAt: '2026-09-21T00:00:00Z', ...overrides,
});
let now = 100;
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now += 31 * 60 * 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  window.localStorage.setItem('CONDUCTOR_DEBUG', '1');
  output = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  window.localStorage.removeItem('CONDUCTOR_DEBUG');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('reply latency diagnostics', () => {
  it('measures send to MessageBubble DOM commit even when the HTTP ack arrives last', () => {
    const attempt = beginReplyTiming('task');
    const message = reply('user-1');
    now += 200;
    observeReplyTiming(message, 'received');
    now += 50;
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Ready.')).toBeInTheDocument();
    expect(output).not.toHaveBeenCalled();
    now += 500;
    attempt?.bind('user-1');
    expect(output).toHaveBeenCalledWith('[conductor-reply-latency]', expect.objectContaining({
      replyTo: 'user-1', sendToFirstReplyCommitMs: 250, sendToReceivedMs: 200, receivedToCommitMs: 50,
    }));
    observeReplyTiming(message, 'committed');
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('starts at the real send action and cancels a rejected send', async () => {
    const userMessage = reply('user', { id: 'sent-user', role: 'user' });
    vi.spyOn(getApiClient(), 'post').mockResolvedValueOnce(userMessage).mockRejectedValueOnce(new Error('offline'));
    await useChatStore.getState().sendMessage('task', { content: 'Hello' });
    now += 40;
    render(<MessageBubble message={reply('sent-user')} />);
    expect(output).toHaveBeenCalledWith('[conductor-reply-latency]', expect.objectContaining({
      replyTo: 'sent-user', sendToFirstReplyCommitMs: 40,
    }));
    await expect(useChatStore.getState().sendMessage('task', { content: 'Again' })).rejects.toThrow('offline');
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('correlates concurrent sends by reply_to and ignores synthetic or empty messages', () => {
    const first = beginReplyTiming('task');
    const second = beginReplyTiming('task');
    first?.bind('first');
    second?.bind('second');
    observeReplyTiming(reply('first', { metadata: { reply_to: 'first', synthetic: true } }), 'committed');
    observeReplyTiming(reply('first', { content: '' }), 'committed');
    observeReplyTiming(reply('first', { taskId: 'another-task' }), 'committed');
    expect(output).not.toHaveBeenCalled();
    now += 20;
    observeReplyTiming(reply('second'), 'committed');
    now += 10;
    observeReplyTiming(reply('first'), 'committed');
    expect(output).toHaveBeenNthCalledWith(1, '[conductor-reply-latency]', expect.objectContaining({ replyTo: 'second', sendToReceivedMs: null }));
    expect(output).toHaveBeenNthCalledWith(2, '[conductor-reply-latency]', expect.objectContaining({ replyTo: 'first' }));
  });

  it('does not log canceled, expired or disabled attempts', () => {
    const canceled = beginReplyTiming('task');
    canceled?.bind('canceled');
    canceled?.cancel();
    observeReplyTiming(reply('canceled'), 'committed');
    const expired = beginReplyTiming('task');
    now += 31 * 60 * 1000;
    observeReplyTiming(reply('expired'), 'committed');
    expired?.bind('expired');
    window.localStorage.removeItem('CONDUCTOR_DEBUG');
    expect(beginReplyTiming('task')).toBeUndefined();
    expect(output).not.toHaveBeenCalled();
  });

  it('caps pending attempts and excludes message content from diagnostics', () => {
    const old = beginReplyTiming('task');
    for (let i = 0; i < 100; i++) beginReplyTiming('task')?.bind(`pending-${i}`);
    old?.bind('old');
    observeReplyTiming(reply('old'), 'committed');
    expect(output).not.toHaveBeenCalled();
    observeReplyTiming(reply('pending-99', { content: 'sensitive prompt' }), 'committed');
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain('sensitive prompt');
  });
});
