import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TaskItem } from './TaskItem';

const pushMock = vi.fn();
const updateTaskMock = vi.fn();
const restartTaskMock = vi.fn();
const deleteTaskMock = vi.fn();
const markTaskReadMock = vi.fn();
const clearRuntimeMock = vi.fn();
const onOpenTaskMock = vi.fn();
const confirmMock = vi.fn();
const pushToastMock = vi.fn();
const apiPostMock = vi.fn();
const FIXED_DATE = new Date('2024-01-15T10:00:00Z');
let runtimeByTask: Record<string, unknown> = {};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('../store', () => ({
  useTasksStore: () => ({
    updateTask: updateTaskMock,
    restartTask: restartTaskMock,
    deleteTask: deleteTaskMock,
    markTaskRead: markTaskReadMock,
  }),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock('@/features/realtime', () => ({
  useRuntimeStore: (
    selector: (state: { byTask: Record<string, unknown>; clearTask: typeof clearRuntimeMock }) => unknown,
  ) =>
    selector({ byTask: runtimeByTask, clearTask: clearRuntimeMock }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    post: apiPostMock,
  }),
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useConfirm: () => ({
    confirm: confirmMock,
  }),
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

vi.mock('./RestartTaskControls', () => ({
  RestartTaskControls: ({ open }: { open?: boolean }) => (open ? <div data-testid="restart-controls" /> : null),
}));

vi.mock('@/components/common/Dialog', () => ({
  Dialog: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: string;
    description?: string;
    children: ReactNode;
  }) => open ? (
    <div>
      <div>{title}</div>
      {description ? <div>{description}</div> : null}
      {children}
    </div>
  ) : null,
}));

describe('TaskItem', () => {
  beforeEach(() => {
    runtimeByTask = {};
    window.sessionStorage.clear();
    pushMock.mockReset();
    updateTaskMock.mockReset();
    restartTaskMock.mockReset();
    deleteTaskMock.mockReset();
    markTaskReadMock.mockReset();
    clearRuntimeMock.mockReset();
    onOpenTaskMock.mockReset();
    confirmMock.mockReset();
    pushToastMock.mockReset();
    apiPostMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows backend labels without daemon labels in task list item', () => {
    render(
      <TaskItem
        task={{
          id: 'task-1',
          title: 'Task One',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          metadata: { backendType: 'claude' },
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.queryByText('daemon-a')).not.toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
  });

  it('shows the worktree branch on the task card metadata row', () => {
    render(
      <TaskItem
        task={{
          id: 'task-worktree-1',
          title: 'Worktree Task',
          taskType: 'ai_task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          launchConfig: {
            worktree: true,
            worktreeBranch: 'abc123',
          },
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('abc123')).toBeInTheDocument();
  });

  it('requires a second click on the running badge before killing the task', async () => {
    updateTaskMock.mockResolvedValue({
      id: 'task-kill-1',
      title: 'Killable Task',
      status: 'killed',
      createdAt: FIXED_DATE.toISOString(),
    });

    render(
      <TaskItem
        task={{
          id: 'task-kill-1',
          title: 'Killable Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
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

  it('does not clear runtime while the backend reports killing', async () => {
    updateTaskMock.mockResolvedValue({
      id: 'task-kill-pending',
      title: 'Kill Pending Task',
      status: 'killing',
      createdAt: FIXED_DATE.toISOString(),
    });

    render(
      <TaskItem
        task={{
          id: 'task-kill-pending',
          title: 'Kill Pending Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: 'killing?' }));

    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledWith('task-kill-pending', { status: 'killed' });
    });
    expect(clearRuntimeMock).not.toHaveBeenCalled();
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
          createdAt: FIXED_DATE.toISOString(),
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
          createdAt: FIXED_DATE.toISOString(),
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
          createdAt: FIXED_DATE.toISOString(),
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
          createdAt: FIXED_DATE.toISOString(),
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

  it('does not show daemon name for direct conductor-fire tasks', () => {
    render(
      <TaskItem
        task={{
          id: 'task-2',
          title: 'Task Two',
          status: 'running',
          projectId: null,
          agentHost: 'conductor-fire-mac-m1-12345',
          metadata: { backendType: 'codex', daemonName: 'mac-studio' },
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.queryByText('mac-studio')).not.toBeInTheDocument();
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
          createdAt: FIXED_DATE.toISOString(),
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

  it('shows runtime preview in the list item', () => {
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
          title: 'List Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          lastUserMessage: 'Write a landing page with pricing cards',
          lastAssistantMessage: 'Older assistant reply',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('Fresh assistant preview')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens the task when clicking the list preview text', async () => {
    vi.useFakeTimers();

    runtimeByTask = {
      'task-8': {
        statusLine: 'Thinking...',
      },
    };

    render(
      <TaskItem
        task={{
          id: 'task-8',
          title: 'Clickable List Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    expect(screen.getByText('Thinking...')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Thinking...'));

    expect(pushMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });

    expect(pushMock).toHaveBeenCalledWith('/app/tasks/task-8');
  });

  it('cancels a pending route open when another task card is clicked', async () => {
    vi.useFakeTimers();

    render(
      <>
        <TaskItem
          task={{
            id: 'task-a',
            title: 'Task A',
            status: 'running',
            projectId: null,
            agentHost: 'daemon-a',
            createdAt: FIXED_DATE.toISOString(),
            updatedAt: null,
          }}
          isUnread={false}
          isSelected={false}
          selectionMode={false}
          onToggleSelect={() => {}}
        />
        <TaskItem
          task={{
            id: 'task-b',
            title: 'Task B',
            status: 'running',
            projectId: null,
            agentHost: 'daemon-a',
            createdAt: FIXED_DATE.toISOString(),
            updatedAt: null,
          }}
          isUnread={false}
          isSelected={false}
          selectionMode={false}
          onToggleSelect={() => {}}
        />
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: /task a/i }));
    await vi.advanceTimersByTimeAsync(250);
    fireEvent.pointerDown(screen.getByRole('button', { name: /task b/i }), {
      pointerId: 1,
      clientX: 160,
      pointerType: 'mouse',
      button: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /task b/i }));
    await vi.advanceTimersByTimeAsync(250);

    expect(pushMock).not.toHaveBeenCalledWith('/app/tasks/task-a');

    await vi.advanceTimersByTimeAsync(251);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/app/tasks/task-b');
  });

  it('keeps double-click rename available on route-opening cards before navigation fires', async () => {
    vi.useFakeTimers();

    render(
      <TaskItem
        task={{
          id: 'task-slow-double-click',
          title: 'Slow Double Click Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    const taskCard = screen.getByRole('button', { name: /slow double click task/i });

    fireEvent.click(taskCard, { detail: 1 });
    await vi.advanceTimersByTimeAsync(450);

    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.click(taskCard, { detail: 2 });

    expect(screen.getByRole('textbox')).toHaveValue('Slow Double Click Task');

    await vi.advanceTimersByTimeAsync(600);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('cancels a pending route open when a nested status control is pressed', async () => {
    vi.useFakeTimers();

    render(
      <TaskItem
        task={{
          id: 'task-status-interrupt',
          title: 'Status Interrupt Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /status interrupt task/i }));
    await vi.advanceTimersByTimeAsync(250);

    const statusButton = screen.getByRole('button', { name: 'running' });
    fireEvent.pointerDown(statusButton, {
      pointerId: 1,
      clientX: 160,
      pointerType: 'mouse',
      button: 0,
    });
    fireEvent.click(statusButton);

    expect(screen.getByRole('button', { name: 'killing?' })).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(400);

    expect(pushMock).not.toHaveBeenCalled();
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
          createdAt: FIXED_DATE.toISOString(),
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
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });
    fireEvent.pointerUp(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });

    expect(await screen.findByRole('button', { name: 'Share task' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));

    expect(screen.getByTestId('restart-controls')).toBeInTheDocument();
  });

  it('closes an in-progress swipe when a parent merge drag activates', () => {
    const task = {
      id: 'task-merge-drag',
      title: 'Merge Drag Task',
      status: 'running',
      projectId: null,
      agentHost: 'daemon-a',
      createdAt: FIXED_DATE.toISOString(),
      updatedAt: null,
    } as const;
    const { rerender } = render(
      <TaskItem
        task={task}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />,
    );

    const card = screen.getByRole('button', { name: /merge drag task/i });
    fireEvent.pointerDown(card, { pointerId: 3, clientX: 240, pointerType: 'touch' });
    fireEvent.pointerMove(card, { pointerId: 3, clientX: 120, pointerType: 'touch' });
    expect(card).not.toHaveStyle({ transform: 'translateX(0px)' });

    rerender(
      <TaskItem
        task={task}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
        isMergeDragging
      />,
    );

    expect(card).toHaveStyle({ transform: 'translateX(0px)' });
  });

  it('pins a task from the swipe-left action menu', async () => {
    updateTaskMock.mockResolvedValue({
      id: 'task-pin-1',
      title: 'Pin Task',
      status: 'running',
      createdAt: FIXED_DATE.toISOString(),
    });

    render(
      <TaskItem
        task={{
          id: 'task-pin-1',
          title: 'Pin Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />,
    );

    const card = screen.getByText('Pin Task').closest('[role="button"]');
    expect(card).not.toBeNull();

    fireEvent.pointerDown(card!, { pointerId: 1, clientX: 240, pointerType: 'touch' });
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });
    fireEvent.pointerUp(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });
    fireEvent.click(await screen.findByRole('button', { name: 'Pin task' }));

    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledWith('task-pin-1', {
        metadata: {
          pinnedAt: expect.any(String),
        },
      });
    });
    expect(Date.parse(updateTaskMock.mock.calls[0][1].metadata.pinnedAt)).not.toBeNaN();
  });

  it('shows an unpin action for pinned tasks', async () => {
    updateTaskMock.mockResolvedValue({
      id: 'task-unpin-1',
      title: 'Unpin Task',
      status: 'running',
      createdAt: FIXED_DATE.toISOString(),
    });

    render(
      <TaskItem
        task={{
          id: 'task-unpin-1',
          title: 'Unpin Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          metadata: { pinnedAt: '2024-01-15T10:30:00.000Z' },
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Unpin task' })).toBeInTheDocument();

    const card = screen.getByText('Unpin Task').closest('[role="button"]');
    expect(card).not.toBeNull();

    fireEvent.pointerDown(card!, { pointerId: 1, clientX: 240, pointerType: 'touch' });
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });
    fireEvent.pointerUp(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });
    fireEvent.click(await screen.findByRole('button', { name: 'Unpin task' }));
    expect(updateTaskMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unpin' }));

    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledWith('task-unpin-1', {
        metadata: {
          pinnedAt: null,
        },
      });
    });
  });

  it('copies the share link with execCommand fallback when clipboard api is unavailable', async () => {
    confirmMock.mockResolvedValue(true);
    apiPostMock.mockResolvedValue({ token: 'shared-token-1' });
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: false,
    });
    const execCommandMock = vi.fn().mockReturnValue(true);
    document.execCommand = execCommandMock;

    render(
      <TaskItem
        task={{
          id: 'task-share-1',
          title: 'Share Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        selectionMode={false}
        onToggleSelect={() => {}}
      />,
    );

    const card = screen.getByText('Share Task').closest('[role="button"]');
    expect(card).not.toBeNull();

    fireEvent.pointerDown(card!, { pointerId: 1, clientX: 240, pointerType: 'touch' });
    fireEvent.pointerMove(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });
    fireEvent.pointerUp(card!, { pointerId: 1, clientX: 40, pointerType: 'touch' });

    fireEvent.click(await screen.findByRole('button', { name: 'Share task' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-share-1/share');
      expect(execCommandMock).toHaveBeenCalledWith('copy');
      expect(pushToastMock).toHaveBeenCalledWith({
        title: 'Link copied',
        description: 'Share link copied to clipboard.',
        variant: 'success',
      });
    });
    // The share dialog has a "Share" title; the swipe button also now
    // carries a (visually hidden) "Share" label, so use getAllByText to
    // assert at least one occurrence rather than failing on multiplicity.
    expect(screen.getAllByText('Share').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'http://localhost:3000/share/shared-token-1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'http://localhost:3000/share/shared-token-1/plain' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[1]);

    await waitFor(() => {
      expect(execCommandMock).toHaveBeenCalledTimes(2);
      expect(pushToastMock).toHaveBeenLastCalledWith({
        title: 'Link copied',
        description: 'http://localhost:3000/share/shared-token-1/plain',
        variant: 'success',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'http://localhost:3000/share/shared-token-1/plain' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    });

    apiPostMock.mockClear();
    confirmMock.mockClear();

    fireEvent.pointerDown(card!, { pointerId: 2, clientX: 240, pointerType: 'touch' });
    fireEvent.pointerMove(card!, { pointerId: 2, clientX: 40, pointerType: 'touch' });
    fireEvent.pointerUp(card!, { pointerId: 2, clientX: 40, pointerType: 'touch' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share task' }));

    expect(confirmMock).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'http://localhost:3000/share/shared-token-1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'http://localhost:3000/share/shared-token-1/plain' })).toBeInTheDocument();
  });

  it('only shows pin and delete in the swipe action menu for pty tasks', async () => {
    render(
      <TaskItem
        task={{
          id: 'task-pty-restart-1',
          title: 'PTY Swipe Task',
          taskType: 'pty_task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
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
    expect(screen.queryByRole('button', { name: 'Share task' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pin task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete task' })).toBeInTheDocument();
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
          createdAt: FIXED_DATE.toISOString(),
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
          createdAt: FIXED_DATE.toISOString(),
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

    const taskCard = screen.getByRole('button', { name: /desktop full page task/i });

    fireEvent.doubleClick(taskCard);

    expect(markTaskReadMock).toHaveBeenCalledWith('task-11');
    expect(pushMock).toHaveBeenCalledWith('/app/tasks/task-11');
    expect(onOpenTaskMock).not.toHaveBeenCalled();
  });

  it('keeps desktop title editing on long press', async () => {
    vi.useFakeTimers();

    render(
      <TaskItem
        task={{
          id: 'task-desktop-rename',
          title: 'Desktop Rename Task',
          status: 'running',
          projectId: null,
          agentHost: 'daemon-a',
          createdAt: FIXED_DATE.toISOString(),
          updatedAt: null,
        }}
        isUnread={false}
        isSelected={false}
        isActive
        selectionMode={false}
        onToggleSelect={() => {}}
        onOpenTask={onOpenTaskMock}
        desktopListPaneMode
      />
    );

    fireEvent.pointerDown(screen.getByText('Desktop Rename Task'), {
      pointerId: 1,
      clientX: 140,
      clientY: 24,
      pointerType: 'mouse',
      button: 0,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });

    expect(screen.getByRole('textbox')).toHaveValue('Desktop Rename Task');
    expect(pushMock).not.toHaveBeenCalled();
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
          createdAt: FIXED_DATE.toISOString(),
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
