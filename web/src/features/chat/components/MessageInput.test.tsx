import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageInput } from './MessageInput';

describe('MessageInput', () => {
  beforeEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
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

  it('stores up to five sent messages and recalls them with ArrowUp', async () => {
    const onSendMock = vi.fn();

    render(
      <MessageInput
        taskId="task-history"
        onSend={onSendMock}
      />,
    );

    const textarea = screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

    const send = (value: string) => {
      fireEvent.change(textarea, { target: { value } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
    };

    send('first');
    send('second');
    send('third');
    send('fourth');
    send('fifth');
    send('sixth');

    expect(onSendMock).toHaveBeenCalledTimes(6);
    expect(textarea.value).toBe('');

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(textarea.value).toBe('sixth');
    });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('fifth');

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('fourth');

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('third');

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('second');

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('second');
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

  it('uses ArrowDown to move forward through recalled history and restore the draft', async () => {
    const onSendMock = vi.fn();

    render(
      <MessageInput
        taskId="task-history-down"
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
