import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskItem } from './TaskItem';

const pushMock = vi.fn();
const updateTaskMock = vi.fn();
const restartTaskMock = vi.fn();
const deleteTaskMock = vi.fn();
const markTaskReadMock = vi.fn();
const sendMessageMock = vi.fn();
const clearRuntimeMock = vi.fn();
const onOpenTaskMock = vi.fn();
let runtimeByTask: Record<string, unknown> = {};
let messagesByTask: Record<string, Array<{ id: string; role: string; content: string }>> = {};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('@/lib/conductor/stores/tasks', () => ({
  useTasksStore: () => ({
    updateTask: updateTaskMock,
    restartTask: restartTaskMock,
    deleteTask: deleteTaskMock,
    markTaskRead: markTaskReadMock,
  }),
}));

vi.mock('@/lib/conductor/stores/chat', () => ({
  useChatStore: (
    selector: (state: {
      sendMessage: typeof sendMessageMock;
      messagesByTask: typeof messagesByTask;
    }) => unknown,
  ) =>
    selector({ sendMessage: sendMessageMock, messagesByTask }),
}));

vi.mock('@/lib/conductor/stores/projects', () => ({
  useProjectsStore: (selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock('@/lib/conductor/stores/runtime', () => ({
  useRuntimeStore: (
    selector: (state: { byTask: Record<string, unknown>; clearTask: typeof clearRuntimeMock }) => unknown,
  ) =>
    selector({ byTask: runtimeByTask, clearTask: clearRuntimeMock }),
}));

vi.mock('./RestartTaskControls', () => ({
  RestartTaskControls: ({ open }: { open?: boolean }) => (open ? <div data-testid="restart-controls" /> : null),
}));

describe('TaskItem', () => {
  beforeEach(() => {
    runtimeByTask = {};
    messagesByTask = {};
    window.sessionStorage.clear();
    pushMock.mockReset();
    updateTaskMock.mockReset();
    restartTaskMock.mockReset();
    deleteTaskMock.mockReset();
    markTaskReadMock.mockReset();
    sendMessageMock.mockReset();
    clearRuntimeMock.mockReset();
    onOpenTaskMock.mockReset();
  });

  it('shows backend and daemon labels in task list item', () => {
    render(
      <TaskItem
        task={{
          id: 'task-1',
          title: 'Task One',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          metadata: { backendType: 'claude' },
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('daemon-a')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
  });

  it('requires a second click on the running badge before killing the task', async () => {
    updateTaskMock.mockResolvedValue({
      id: 'task-kill-1',
      title: 'Killable Task',
      status: 'killed',
      createdAt: new Date().toISOString(),
    });

    render(
      <TaskItem
        task={{
          id: 'task-kill-1',
          title: 'Killable Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'running' }));

    expect(screen.getByRole('button', { name: 'killing?' })).toBeInTheDocument();
    expect(updateTaskMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'killing?' }));

    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledWith('task-kill-1', { status: 'killed' });
      expect(clearRuntimeMock).toHaveBeenCalledWith('task-kill-1');
    });
  });

  it('cancels killing confirmation when clicking elsewhere', () => {
    render(
      <TaskItem
        task={{
          id: 'task-kill-2',
          title: 'Cancel Kill Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'running' }));
    expect(screen.getByRole('button', { name: 'killing?' })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByText('Cancel Kill Task'));
    fireEvent.click(screen.getByText('Cancel Kill Task'));

    expect(screen.getByRole('button', { name: 'running' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'killing?' })).not.toBeInTheDocument();
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('requires a second click on the completed badge before restarting the task in place', async () => {
    restartTaskMock.mockResolvedValue({
      mode: 'inplace_restart',
      sourceTaskId: 'task-restart-1',
      task: {
        id: 'task-restart-1',
      },
    });

    render(
      <TaskItem
        task={{
          id: 'task-restart-1',
          title: 'Restartable Task',
          taskType: 'ai_task',
          status: 'completed',
          projectId: null,
          agentHost: 'daemon-a',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'completed' }));

    expect(screen.getByRole('button', { name: 'restart?' })).toBeInTheDocument();
    expect(restartTaskMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'restart?' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-restart-1', {
        strategy: 'inplace',
      });
      expect(clearRuntimeMock).toHaveBeenCalledWith('task-restart-1');
    });
  });

  it('cancels restart confirmation when clicking elsewhere', () => {
    render(
      <TaskItem
        task={{
          id: 'task-restart-2',
          title: 'Cancel Restart Task',
          taskType: 'ai_task',
          status: 'unknown',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'unknown' }));
    expect(screen.getByRole('button', { name: 'restart?' })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByText('Cancel Restart Task'));
    fireEvent.click(screen.getByText('Cancel Restart Task'));

    expect(screen.getByRole('button', { name: 'unknown' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'restart?' })).not.toBeInTheDocument();
    expect(restartTaskMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not allow quick restart from init status', () => {
    render(
      <TaskItem
        task={{
          id: 'task-init-1',
          title: 'Init Task',
          taskType: 'ai_task',
          status: 'init',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('init')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'init' })).not.toBeInTheDocument();
  });

  it('shows daemon name for direct conductor-fire tasks', () => {
    render(
      <TaskItem
        task={{
          id: 'task-2',
          title: 'Task Two',
          status: 'running',
          projectId: null,
          agentHost: 'conductor-fire-mac-m1-12345',
          metadata: { backendType: 'codex', daemonName: 'mac-studio' },
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('mac-studio')).toBeInTheDocument();
    expect(screen.queryByText('conductor-fire-mac-m1-12345')).not.toBeInTheDocument();
  });

  it('shows PTY badge and tool preset for pty_task items', () => {
    render(
      <TaskItem
        task={{
          id: 'task-3',
          title: 'Terminal Task',
          taskType: 'pty_task',
          status: 'unknown',
          projectId: null,
          agentHost: 'daemon-a',
          launchConfig: { toolPreset: 'codex' },
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('PTY')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
  });

  it('shows input and last ai preview in grid mode', () => {
    runtimeByTask = {
      'task-4': {
        replyPreview: 'Fresh assistant preview',
        replyInProgress: true,
      },
    };

    render(
      <TaskItem
        task={{
          id: 'task-4',
          title: 'Grid Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          lastUserMessage: 'Write a landing page with pricing cards',
          lastAssistantMessage: 'Older assistant reply',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        viewMode="grid"
      />
    );

    expect(screen.getByText('Last AI')).toBeInTheDocument();
    expect(screen.getByText('Fresh assistant preview')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Write a landing page with pricing cards')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
    expect(screen.queryByText('Enter to send • Shift+Enter for newline')).not.toBeInTheDocument();
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument();
  });

  it('sends a real message from the grid input composer', async () => {
    sendMessageMock.mockResolvedValue({
      id: 'message-1',
      taskId: 'task-5',
      role: 'user',
      content: 'Ship the pricing page',
      createdAt: new Date().toISOString(),
    });

    render(
      <TaskItem
        task={{
          id: 'task-5',
          title: 'Grid Composer Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        viewMode="grid"
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Type a message...'), {
      target: { value: 'Ship the pricing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(clearRuntimeMock).toHaveBeenCalledWith('task-5');
      expect(sendMessageMock).toHaveBeenCalledWith('task-5', {
        content: 'Ship the pricing page',
        role: 'user',
      });
    });

    expect(screen.getByPlaceholderText('Ship the pricing page')).toHaveValue('');
  });

  it('prefers the latest ai message content over runtime status and does not navigate when clicking ai/input areas', () => {
    runtimeByTask = {
      'task-8': {
        statusLine: 'Thinking...',
      },
    };
    messagesByTask = {
      'task-8': [
        { id: 'm1', role: 'user', content: 'hello' },
        { id: 'm2', role: 'assistant', content: 'Latest assistant reply' },
      ],
    };

    render(
      <TaskItem
        task={{
          id: 'task-8',
          title: 'Clickable Grid Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        viewMode="grid"
      />
    );

    expect(screen.getByText('Latest assistant reply')).toBeInTheDocument();
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
    expect(screen.queryByText('Last AI')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Thinking...'));
    fireEvent.click(screen.getByPlaceholderText('Type a message...'));

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('supports Enter to send and Shift+Enter to keep drafting in grid mode', async () => {
    sendMessageMock.mockResolvedValue({
      id: 'message-2',
      taskId: 'task-6',
      role: 'user',
      content: 'Line one',
      createdAt: new Date().toISOString(),
    });

    render(
      <TaskItem
        task={{
          id: 'task-6',
          title: 'Keyboard Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        viewMode="grid"
      />
    );

    const textarea = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(textarea, { target: { value: 'Line one' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(sendMessageMock).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('task-6', {
        content: 'Line one',
        role: 'user',
      });
    });
  });

  it('opens new task from the swipe-left action menu', async () => {
    render(
      <TaskItem
        task={{
          id: 'task-9',
          title: 'Swipe Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />,
    );

    const card = screen.getByText('Swipe Task').closest('[role="button"]');
    expect(card).not.toBeNull();

    fireEvent.pointerDown(card!, { pointerId: 1, clientX: 240, pointerType: 'touch' });
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 80, pointerType: 'touch' });
    fireEvent.pointerUp(card!, { pointerId: 1, clientX: 80, pointerType: 'touch' });

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));

    expect(screen.getByTestId('restart-controls')).toBeInTheDocument();
  });

  it('does not show restart in the swipe action menu for pty tasks', async () => {
    render(
      <TaskItem
        task={{
          id: 'task-pty-restart-1',
          title: 'PTY Swipe Task',
          taskType: 'pty_task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />,
    );

    const card = screen.getByText('PTY Swipe Task').closest('[role="button"]');
    expect(card).not.toBeNull();

    fireEvent.pointerDown(card!, { pointerId: 1, clientX: 240, pointerType: 'touch' });
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 120, pointerType: 'touch' });
    fireEvent.pointerUp(card!, { pointerId: 1, clientX: 120, pointerType: 'touch' });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Rename task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete task' })).toBeInTheDocument();
  });

  it('persists grid draft in session storage', () => {
    const { unmount } = render(
      <TaskItem
        task={{
          id: 'task-7',
          title: 'Draft Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        viewMode="grid"
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Type a message...'), {
      target: { value: 'Saved draft content' },
    });

    expect(window.sessionStorage.getItem('conductor-grid-task-draft:task-7')).toBe('Saved draft content');

    unmount();

    render(
      <TaskItem
        task={{
          id: 'task-7',
          title: 'Draft Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        viewMode="grid"
      />
    );

    expect(screen.getByPlaceholderText('Type a message...')).toHaveValue('Saved draft content');
  });

  it('uses inline task opening when provided instead of navigating', () => {
    render(
      <TaskItem
        task={{
          id: 'task-9',
          title: 'Inline Detail Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread
        isSelected={false}
        isActive
        selectionMode={false}
        onToggleSelect={() => {}}
        onOpenTask={onOpenTaskMock}
        desktopListPaneMode
      />
    );

    const taskCard = screen.getByRole('button', { name: /inline detail task/i });
    expect(taskCard).toHaveClass('webapp-card-list-pane-active');

    fireEvent.click(taskCard);

    expect(markTaskReadMock).toHaveBeenCalledWith('task-9');
    expect(onOpenTaskMock).toHaveBeenCalledWith('task-9');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('navigates to the full task page on desktop list double click', () => {
    render(
      <TaskItem
        task={{
          id: 'task-11',
          title: 'Desktop Full Page Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread
        isSelected={false}
        isActive
        selectionMode={false}
        onToggleSelect={() => {}}
        onOpenTask={onOpenTaskMock}
        desktopListPaneMode
      />
    );

    fireEvent.doubleClick(screen.getByRole('button', { name: /desktop full page task/i }));

    expect(markTaskReadMock).toHaveBeenCalledWith('task-11');
    expect(pushMock).toHaveBeenCalledWith('/app/tasks/task-11');
    expect(onOpenTaskMock).not.toHaveBeenCalled();
  });

  it('uses the intermediate background for inactive cards in desktop list pane mode', () => {
    render(
      <TaskItem
        task={{
          id: 'task-10',
          title: 'Inactive Pane Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: new Date().toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        isActive={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        desktopListPaneMode
      />
    );

    expect(screen.getByRole('button', { name: /inactive pane task/i })).toHaveClass('webapp-card-list-pane-idle');
  });
});
