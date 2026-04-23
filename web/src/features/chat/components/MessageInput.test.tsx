import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageInput } from './MessageInput';
import { useChatStore } from '../store';
import type { Message } from '@/shared/types';

const resetChatStore = () => {
  useChatStore.setState({
    messagesByTask: {},
    historyStateByTask: {},
    hydratedTaskIds: new Set(),
    loadingTasks: new Set(),
    error: null,
  });
};

const seedUserMessages = (taskId: string, contents: string[]) => {
  const now = Date.now();
  const messages: Message[] = contents.map((content, index) => ({
    id: `seed-${taskId}-${index}`,
    taskId,
    role: 'user',
    content,
    createdAt: new Date(now + index).toISOString(),
  }));
  useChatStore.setState((state) => ({
    messagesByTask: {
      ...state.messagesByTask,
      [taskId]: messages,
    },
  }));
};

const appendUserMessage = (taskId: string, content: string) => {
  useChatStore.getState().addMessage(taskId, {
    id: `sent-${taskId}-${Date.now()}-${Math.random()}`,
    taskId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  });
};

describe('MessageInput', () => {
  beforeEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    resetChatStore();
  });

  it('autofocuses the composer when requested', async () => {
    render(
      <MessageInput
        taskId="task-focus"
        onSend={() => {}}
        autoFocus
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea');

    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it('recalls every user prompt from the chat history via ArrowUp, newest first', async () => {
    const taskId = 'task-history';
    // Simulate a history that includes prompts sent from a different web
    // client (loaded via fetchMessages) alongside a just-sent prompt.
    seedUserMessages(taskId, ['first', 'second', 'third', 'fourth', 'fifth']);

    const onSendMock = vi.fn((content: string) => {
      appendUserMessage(taskId, content);
    });

    render(
      <MessageInput
        taskId={taskId}
        onSend={onSendMock}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

    // Send a sixth prompt locally — it should join the same history.
    fireEvent.change(textarea, { target: { value: 'sixth' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSendMock).toHaveBeenCalledWith('sixth');
    expect(textarea.value).toBe('');

    const expectedOrder = ['sixth', 'fifth', 'fourth', 'third', 'second', 'first'];
    for (let i = 0; i < expectedOrder.length; i += 1) {
      fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => {
        expect(textarea.value).toBe(expectedOrder[i]);
      });
    }

    // ArrowUp past the oldest prompt should stay on it.
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first');
  });

  it('ignores non-user messages and deduplicates repeated prompts', async () => {
    const taskId = 'task-history-dedupe';
    useChatStore.setState((state) => ({
      messagesByTask: {
        ...state.messagesByTask,
        [taskId]: [
          {
            id: 'm-1',
            taskId,
            role: 'user',
            content: 'hello',
            createdAt: '2026-04-22T10:00:00.000Z',
          },
          {
            id: 'm-2',
            taskId,
            role: 'assistant',
            content: 'hi there',
            createdAt: '2026-04-22T10:00:01.000Z',
          },
          {
            id: 'm-3',
            taskId,
            role: 'user',
            content: 'what is up',
            createdAt: '2026-04-22T10:00:02.000Z',
          },
          {
            id: 'm-4',
            taskId,
            role: 'user',
            content: 'hello',
            createdAt: '2026-04-22T10:00:03.000Z',
          },
        ],
      },
    }));

    render(
      <MessageInput
        taskId={taskId}
        onSend={() => {}}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    await waitFor(() => {
      // Most recent user prompt.
      expect(textarea.value).toBe('hello');
    });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    // Skips the assistant reply and the older duplicate "hello".
    expect(textarea.value).toBe('what is up');

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    // No third user prompt because the older "hello" was deduped.
    expect(textarea.value).toBe('what is up');
  });

  it('submits a resend request through the normal send flow', async () => {
    const onSendMock = vi.fn();
    const { rerender } = render(
      <MessageInput
        taskId="task-resend"
        onSend={onSendMock}
      />,
    );

    rerender(
      <MessageInput
        taskId="task-resend"
        onSend={onSendMock}
        resendRequest={{ id: 1, content: '  repeat this  ' }}
      />,
    );

    await waitFor(() => {
      expect(onSendMock).toHaveBeenCalledWith('repeat this');
    });
    expect(screen.getByTestId('message-input-textarea')).toHaveValue('');
  });

  it('keeps a resend request in the composer when sending is disabled', async () => {
    const onSendMock = vi.fn();
    const { rerender } = render(
      <MessageInput
        taskId="task-resend-disabled"
        onSend={onSendMock}
        sendDisabled
      />,
    );

    rerender(
      <MessageInput
        taskId="task-resend-disabled"
        onSend={onSendMock}
        sendDisabled
        resendRequest={{ id: 1, content: 'retry when ready' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('message-input-textarea')).toHaveValue('retry when ready');
    });
    expect(onSendMock).not.toHaveBeenCalled();
  });

  it('keeps ArrowUp anchored to the current prompt when a new user message appears mid-browse', async () => {
    // Simulates another signed-in web client pushing a user message (via
    // websocket) while the user is already paging through history. The
    // browsing cursor must stay on the same prompt the user was looking at,
    // so the next ArrowUp steps one entry older — not two.
    const taskId = 'task-history-ws-append';
    seedUserMessages(taskId, ['alpha', 'beta', 'gamma']);

    render(
      <MessageInput
        taskId={taskId}
        onSend={() => {}}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(textarea.value).toBe('gamma');
    });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('beta');

    // Websocket push arrives while the user is parked on "beta".
    act(() => {
      appendUserMessage(taskId, 'delta');
    });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    // Expect "alpha" (one older than "beta"), not "gamma" (one older than
    // the freshly-appended "delta" under index-based cursoring).
    expect(textarea.value).toBe('alpha');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('beta');
  });

  it('survives pagination that prepends older prompts while the user browses', async () => {
    const taskId = 'task-history-prepend';
    seedUserMessages(taskId, ['charlie', 'delta']);

    render(
      <MessageInput
        taskId={taskId}
        onSend={() => {}}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(textarea.value).toBe('delta');
    });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('charlie');

    // A "load earlier" pagination call resolves: two older prompts are
    // prepended to the task's message log.
    act(() => {
      useChatStore.setState((state) => {
        const now = Date.now();
        const older: Message[] = [
          {
            id: `prepend-${taskId}-0`,
            taskId,
            role: 'user',
            content: 'alpha',
            createdAt: new Date(now - 200).toISOString(),
          },
          {
            id: `prepend-${taskId}-1`,
            taskId,
            role: 'user',
            content: 'bravo',
            createdAt: new Date(now - 100).toISOString(),
          },
        ];
        const existing = state.messagesByTask[taskId] ?? [];
        return {
          messagesByTask: {
            ...state.messagesByTask,
            [taskId]: [...older, ...existing],
          },
        };
      });
    });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    // "charlie" was the oldest visible before; now "bravo" is one older.
    expect(textarea.value).toBe('bravo');
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('alpha');

    // Already at the oldest — subsequent ArrowUp is a no-op.
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('alpha');
  });

  it('exits browsing mode and restores the draft when the anchored prompt disappears', async () => {
    const taskId = 'task-history-cleared';
    seedUserMessages(taskId, ['one', 'two']);

    render(
      <MessageInput
        taskId={taskId}
        onSend={() => {}}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'work-in-progress' } });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(textarea.value).toBe('two');
    });

    // The anchored prompt is removed from the chat store (e.g. the task's
    // messages were cleared between keypresses).
    act(() => {
      useChatStore.getState().clearMessages(taskId);
      seedUserMessages(taskId, ['unrelated']);
    });

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    // Anchored prompt "two" is gone → bail out of browsing and restore draft.
    expect(textarea.value).toBe('work-in-progress');
  });

  it('uses ArrowDown to move forward through recalled history and restore the draft', async () => {
    const taskId = 'task-history-down';
    const onSendMock = vi.fn((content: string) => {
      appendUserMessage(taskId, content);
    });

    render(
      <MessageInput
        taskId={taskId}
        onSend={onSendMock}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'first' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.change(textarea, { target: { value: 'second' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.change(textarea, { target: { value: 'draft' } });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(textarea.value).toBe('second');
    });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('second');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('draft');
  });

  it('rotates multiple placeholder prompts over time', () => {
    vi.useFakeTimers();

    render(
      <MessageInput
        taskId="task-placeholder"
        onSend={() => {}}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe('Type a message...');

    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(textarea.placeholder).toBe('Ask Conductor what to do next…');

    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(textarea.placeholder).toBe('Paste a concrete task to get started…');
  });

  it('uses Escape to interrupt when the composer is empty', () => {
    const onInterruptMock = vi.fn();

    render(
      <MessageInput
        taskId="task-interrupt"
        onSend={() => {}}
        onInterrupt={onInterruptMock}
        interruptEnabled
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea');
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(onInterruptMock).toHaveBeenCalledTimes(1);
  });

  it('does not use Escape to interrupt when the composer still has content', () => {
    const onInterruptMock = vi.fn();

    render(
      <MessageInput
        taskId="task-interrupt-content"
        onSend={() => {}}
        onInterrupt={onInterruptMock}
        interruptEnabled
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea');
    fireEvent.change(textarea, { target: { value: 'still typing' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(onInterruptMock).not.toHaveBeenCalled();
  });

  it('does not open an interrupt action sheet from the composer', () => {
    render(
      <MessageInput
        taskId="task-interrupt-composer"
        onSend={() => {}}
        interruptEnabled
      />,
    );

    fireEvent.doubleClick(screen.getByTestId('message-input-composer'));
    fireEvent.doubleClick(screen.getByTestId('message-input-textarea'));

    expect(screen.queryByTestId('message-input-interrupt-button')).not.toBeInTheDocument();
  });
});
