import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { useChatStore } from '../store';
import { useCatchphrasesStore, type Catchphrase } from '@/features/catchphrases/store';
import type { Message } from '@/shared/types';

const seedCatchphrases = (rows: Partial<Catchphrase>[]) => {
  const normalized: Catchphrase[] = rows.map((row, index) => ({
    id: row.id ?? `cp-${index}`,
    text: row.text ?? `phrase ${index}`,
    sortOrder: row.sortOrder ?? index,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt ?? '2026-06-06T00:00:00Z',
    updatedAt: row.updatedAt ?? '2026-06-06T00:00:00Z',
  }));
  useCatchphrasesStore.setState({
    catchphrases: normalized,
    hydrated: true,
    loading: false,
    error: null,
  });
};

const resetCatchphrasesStore = () => {
  useCatchphrasesStore.setState({
    catchphrases: [],
    // Mark hydrated so the popover does not fire its lazy GET when opened —
    // tests don't want an async fetch leaking past act() boundaries.
    hydrated: true,
    loading: false,
    error: null,
  });
};

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
    resetCatchphrasesStore();
    // The catchphrase popover fires `touch` (POST /api/.../touch) on pick/send
    // as a best-effort recency bump. In tests there's no server, so without a
    // stub we get ECONNREFUSED stderr noise. The store swallows the error
    // (test passes either way), but stubbing keeps the output clean.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
  });

  it('reveals the attach and schedule actions from the swipe menu toggle', () => {
    const onSend = vi.fn();
    const onSchedule = vi.fn();
    render(<MessageInput taskId="task-swipe" onSend={onSend} onSchedule={onSchedule} />);

    const toggle = screen.getByTestId('message-input-actions-toggle');
    // Closed by default: the revealed actions are not focusable.
    expect(screen.getByTestId('message-input-attach-button')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('message-input-swipe-actions')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(toggle);

    expect(screen.getByTestId('message-input-swipe-actions')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('message-input-attach-button')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('message-input-schedule-button')).toHaveAttribute('tabindex', '0');
  });

  it('schedules the current draft from the swipe menu', () => {
    const onSchedule = vi.fn();
    render(<MessageInput taskId="task-schedule" onSend={vi.fn()} onSchedule={onSchedule} />);
    fireEvent.change(screen.getByTestId('message-input-textarea'), { target: { value: 'ping me later' } });

    fireEvent.click(screen.getByTestId('message-input-actions-toggle'));
    fireEvent.click(screen.getByTestId('message-input-schedule-button'));

    expect(onSchedule).toHaveBeenCalledWith('ping me later');
    // The menu closes after the action fires.
    expect(screen.getByTestId('message-input-swipe-actions')).toHaveAttribute('aria-hidden', 'true');
  });

  it('omits the schedule action when scheduling is unavailable', () => {
    render(<MessageInput taskId="task-no-schedule" onSend={vi.fn()} />);
    fireEvent.click(screen.getByTestId('message-input-actions-toggle'));
    expect(screen.queryByTestId('message-input-schedule-button')).toBeNull();
    expect(screen.getByTestId('message-input-attach-button')).toBeTruthy();
  });

  it('selects and sends multiple files in their original order', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageInput taskId="task-files" onSend={onSend} />);
    const image = new File(['image'], 'diagram.png', { type: 'image/png' });
    const notes = new File(['notes'], 'notes.md', { type: 'text/markdown' });

    fireEvent.change(screen.getByTestId('message-input-file-picker'), {
      target: { files: [image, notes] },
    });
    // File selection runs image compression asynchronously before the chips appear.
    await screen.findByText('diagram.png');
    expect(screen.getByText('notes.md')).toBeTruthy();
    fireEvent.change(screen.getByTestId('message-input-textarea'), { target: { value: 'inspect' } });
    fireEvent.click(screen.getByTestId('message-input-send-button'));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('inspect', [image, notes]));
    await waitFor(() => expect(screen.queryByTestId('message-input-files')).toBeNull());
  });

  it('rejects video files before sending', () => {
    const onSend = vi.fn();
    render(<MessageInput taskId="task-video" onSend={onSend} />);
    fireEvent.change(screen.getByTestId('message-input-file-picker'), {
      target: { files: [new File(['video'], 'clip.mp4', { type: 'video/mp4' })] },
    });

    expect(screen.getByText('Video attachments are not supported.')).toBeTruthy();
    expect(screen.queryByTestId('message-input-files')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('rejects native images above 20 MB before upload', async () => {
    render(<MessageInput taskId="task-large-image" onSend={vi.fn()} />);
    const image = new File(['x'], 'large.png', { type: '' });
    Object.defineProperty(image, 'size', { value: 20 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByTestId('message-input-file-picker'), { target: { files: [image] } });
    // With no browser image encoder available the oversized image is not
    // compressible, so the existing 20 MB guard still rejects it.
    await screen.findByText('large.png exceeds the 20 MB image limit.');
    expect(screen.queryByTestId('message-input-files')).toBeNull();
  });

  it('retains selected files when upload or send fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network down'));
    render(<MessageInput taskId="task-retry-files" onSend={onSend} />);
    const notes = new File(['notes'], 'notes.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByTestId('message-input-file-picker'), { target: { files: [notes] } });
    await screen.findByText('notes.md');
    fireEvent.click(screen.getByTestId('message-input-send-button'));

    await screen.findByText('Upload or send failed. Your files are still selected; please retry.');
    expect(screen.getByText('notes.md')).toBeTruthy();
  });

  it('retains the text draft when a text-only send fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network down'));
    render(<MessageInput taskId="task-retry-text" onSend={onSend} />);
    const textarea = screen.getByTestId('message-input-textarea');
    fireEvent.change(textarea, { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByTestId('message-input-send-button'));

    await screen.findByText('Send failed. Your message is still here; please retry.');
    expect(textarea).toHaveValue('keep this draft');
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
    const inputRef = createRef<MessageInputHandle>();

    render(
      <MessageInput
        ref={inputRef}
        taskId="task-resend"
        onSend={onSendMock}
      />,
    );

    act(() => {
      inputRef.current?.resend('  repeat this  ');
    });

    await waitFor(() => {
      expect(onSendMock).toHaveBeenCalledWith('repeat this');
    });
    expect(screen.getByTestId('message-input-textarea')).toHaveValue('');
  });

  it('keeps a resend request in the composer when sending is disabled', async () => {
    const onSendMock = vi.fn();
    const inputRef = createRef<MessageInputHandle>();

    render(
      <MessageInput
        ref={inputRef}
        taskId="task-resend-disabled"
        onSend={onSendMock}
        sendDisabled
      />,
    );

    act(() => {
      inputRef.current?.resend('retry when ready');
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-input-textarea')).toHaveValue('retry when ready');
    });
    expect(onSendMock).not.toHaveBeenCalled();
  });

  it('double-clicking the send button inserts into the current turn when insert is enabled', () => {
    const onSendMock = vi.fn();
    const onInsertMock = vi.fn();
    render(
      <MessageInput
        taskId="task-insert-dbl"
        onSend={onSendMock}
        onInsert={onInsertMock}
        insertEnabled
      />,
    );
    const textarea = screen.getByTestId('message-input-textarea');
    fireEvent.change(textarea, { target: { value: 'urgent note' } });

    const button = screen.getByTestId('message-input-send-button');
    // Two clicks within the double-click window => insert, not send.
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onInsertMock).toHaveBeenCalledWith('urgent note');
    expect(onSendMock).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('');
  });

  it('single-clicking the send button still sends (after the double-click window) when insert is enabled', () => {
    vi.useFakeTimers();
    try {
      const onSendMock = vi.fn();
      const onInsertMock = vi.fn();
      render(
        <MessageInput
          taskId="task-insert-single"
          onSend={onSendMock}
          onInsert={onInsertMock}
          insertEnabled
        />,
      );
      const textarea = screen.getByTestId('message-input-textarea');
      fireEvent.change(textarea, { target: { value: 'queued note' } });

      fireEvent.click(screen.getByTestId('message-input-send-button'));
      // Deferred until the double-click window elapses.
      expect(onSendMock).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(onSendMock).toHaveBeenCalledWith('queued note');
      expect(onInsertMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends immediately on a single click when insert is not available', () => {
    const onSendMock = vi.fn();
    const onInsertMock = vi.fn();
    render(
      <MessageInput
        taskId="task-insert-off"
        onSend={onSendMock}
        onInsert={onInsertMock}
      />,
    );
    const textarea = screen.getByTestId('message-input-textarea');
    fireEvent.change(textarea, { target: { value: 'plain send' } });
    fireEvent.click(screen.getByTestId('message-input-send-button'));

    expect(onSendMock).toHaveBeenCalledWith('plain send');
    expect(onInsertMock).not.toHaveBeenCalled();
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

  describe('catchphrase popover (RFC 0032)', () => {
    it('opens on double-clicking an empty textarea', () => {
      seedCatchphrases([
        { id: 'cp-a', text: 'phrase A' },
        { id: 'cp-b', text: 'phrase B' },
      ]);
      render(<MessageInput taskId="task-cp-open" onSend={() => {}} />);
      const textarea = screen.getByTestId('message-input-textarea');
      fireEvent.doubleClick(textarea);
      expect(screen.getByTestId('catchphrase-popover')).toBeInTheDocument();
      expect(screen.getByTestId('catchphrase-popover-item-cp-a')).toBeInTheDocument();
      expect(screen.getByTestId('catchphrase-popover-item-cp-b')).toBeInTheDocument();
    });

    it('uses theme-token classes for the popover surface and rows', () => {
      seedCatchphrases([{ id: 'cp-a', text: 'phrase A' }]);
      render(<MessageInput taskId="task-cp-theme" onSend={() => {}} />);
      fireEvent.doubleClick(screen.getByTestId('message-input-textarea'));

      const popover = screen.getByTestId('catchphrase-popover');
      expect(popover).toHaveClass('catchphrase-popover-surface');
      expect(popover.className).not.toContain('dark:bg');
      expect(popover.className).not.toContain('dark:text');

      const row = screen.getByTestId('catchphrase-popover-item-cp-a');
      expect(row).toHaveClass('catchphrase-popover-row');
      expect(row.className).not.toContain('dark:text');
    });

    it('does NOT open and does NOT preventDefault on a non-empty textarea', () => {
      seedCatchphrases([{ id: 'cp-a', text: 'phrase A' }]);
      render(<MessageInput taskId="task-cp-nonempty" onSend={() => {}} />);
      const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'already typed' } });

      // The dblclick event must NOT be defaultPrevented — that's how we leave
      // the browser's native double-click-to-select-word behavior intact.
      const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByTestId('catchphrase-popover')).not.toBeInTheDocument();
    });

    it('does not open while IME composition is in progress', () => {
      seedCatchphrases([{ id: 'cp-a', text: 'phrase A' }]);
      render(<MessageInput taskId="task-cp-ime" onSend={() => {}} />);
      const textarea = screen.getByTestId('message-input-textarea');
      fireEvent.compositionStart(textarea);
      fireEvent.doubleClick(textarea);
      expect(screen.queryByTestId('catchphrase-popover')).not.toBeInTheDocument();
      fireEvent.compositionEnd(textarea);
    });

    it('single-clicking a row fills the textarea, places caret at end, and closes the popover', async () => {
      seedCatchphrases([{ id: 'cp-fill', text: '请用中文回答' }]);
      render(<MessageInput taskId="task-cp-fill" onSend={() => {}} />);
      const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
      fireEvent.doubleClick(textarea);

      fireEvent.click(screen.getByTestId('catchphrase-popover-item-cp-fill'));

      await waitFor(() => {
        expect(textarea.value).toBe('请用中文回答');
      });
      // RFC 0032 acceptance bullet 3: caret must land at the end of the text
      // so the user can append more without re-clicking.
      await waitFor(() => {
        expect(textarea.selectionStart).toBe(textarea.value.length);
        expect(textarea.selectionEnd).toBe(textarea.value.length);
      });
      expect(screen.queryByTestId('catchphrase-popover')).not.toBeInTheDocument();
    });

    it('double-clicking a row submits the catchphrase via onSend', async () => {
      vi.useFakeTimers();
      seedCatchphrases([{ id: 'cp-send', text: 'ship it' }]);
      const onSendMock = vi.fn();
      render(<MessageInput taskId="task-cp-send" onSend={onSendMock} />);
      const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
      fireEvent.doubleClick(textarea);

      const row = screen.getByTestId('catchphrase-popover-item-cp-send');
      fireEvent.click(row, { detail: 1 });
      fireEvent.click(row, { detail: 2 });
      fireEvent.doubleClick(row, { detail: 2 });

      expect(onSendMock).toHaveBeenCalledWith('ship it');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(textarea.value).toBe('');
      expect(screen.queryByTestId('catchphrase-popover')).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it('auto-closes when the textarea becomes non-empty after opening', () => {
      seedCatchphrases([{ id: 'cp-auto', text: 'phrase' }]);
      render(<MessageInput taskId="task-cp-auto" onSend={() => {}} />);
      const textarea = screen.getByTestId('message-input-textarea');
      fireEvent.doubleClick(textarea);
      expect(screen.getByTestId('catchphrase-popover')).toBeInTheDocument();

      fireEvent.change(textarea, { target: { value: 'a' } });
      expect(screen.queryByTestId('catchphrase-popover')).not.toBeInTheDocument();
    });

    it('shows the empty-state hint when the library is empty', () => {
      // resetCatchphrasesStore already leaves catchphrases=[] and hydrated=true.
      render(<MessageInput taskId="task-cp-empty" onSend={() => {}} />);
      const textarea = screen.getByTestId('message-input-textarea');
      fireEvent.doubleClick(textarea);
      expect(screen.getByTestId('catchphrase-popover-empty-link')).toBeInTheDocument();
    });

    it('shows a retryable error instead of the empty state when hydrate fails', async () => {
      const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      });
      try {
        resetCatchphrasesStore();
        vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
        useCatchphrasesStore.setState({
          hydrated: false,
          loading: false,
          error: null,
        });
        render(<MessageInput taskId="task-cp-hydrate-error" onSend={() => {}} />);
        fireEvent.doubleClick(screen.getByTestId('message-input-textarea'));

        await waitFor(() => {
          expect(screen.getByText('network down')).toBeInTheDocument();
        });
        expect(screen.getByTestId('catchphrase-popover-retry')).toBeInTheDocument();
        expect(screen.queryByTestId('catchphrase-popover-empty-link')).not.toBeInTheDocument();
        expect(useCatchphrasesStore.getState().hydrated).toBe(false);
      } finally {
        if (localStorageDescriptor) Object.defineProperty(window, 'localStorage', localStorageDescriptor);
      }
    });
  });
});
