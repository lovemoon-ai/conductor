import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ChatView } from './ChatView';
import { useChatStore } from '../store';
import { useRuntimeStore } from '@/features/realtime/runtime-store';
import { useTasksStore } from '@/features/tasks/store';
import type { Message } from '@/shared/types';

const probe = vi.hoisted(() => ({ markdownRenders: 0 }));
vi.mock('react-markdown', async (original) => {
  const actual = await original<typeof import('react-markdown')>();
  return { ...actual, default: (props: Parameters<typeof actual.default>[0]) => {
    probe.markdownRenders++;
    return <actual.default {...props} />;
  } };
});
vi.mock('@/features/projects', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({ fetchProjects: async () => {} }) }));
vi.mock('@/features/realtime', async () => ({
  useRuntimeStore: (await import('@/features/realtime/runtime-store')).useRuntimeStore,
  useWebSocketStore: (select: (state: { status: string }) => unknown) => select({ status: 'disconnected' }),
  requestTaskRuntimeStatus: () => {},
}));
vi.mock('./MessageInput', () => ({ MessageInput: () => null }));
vi.mock('./ScheduledMessageDialog', () => ({ ScheduledMessageDialog: () => null }));
vi.mock('@/features/tasks/components/PersistentTaskDialogs', () => ({ NewRoundDialog: () => null }));

const makeMessage = (id: string, taskId = 'visible-task'): Message => ({
  id, taskId, role: 'sdk', content: `### Result ${id}\n\nA reply with **formatting**.\n\n- First point\n- Second point\n\n\`\`\`ts\nconst answer = 42;\n\`\`\``,
  createdAt: '2026-09-20T00:00:00.000Z',
});
const initialChatState = useChatStore.getState();
const initialTasksState = useTasksStore.getState();

beforeEach(() => {
  sessionStorage.clear();
  useChatStore.setState({ ...initialChatState, messagesByTask: { 'visible-task': Array.from({ length: 200 }, (_, i) => makeMessage(String(i))) }, fetchMessages: async () => {} });
  useTasksStore.setState({ ...initialTasksState, tasks: [{ id: 'visible-task', projectId: 'project', title: 'Visible', status: 'running', taskType: 'ai_task', createdAt: '2026-09-20T00:00:00.000Z' }], fetchTask: async () => null });
  useRuntimeStore.getState().clearAll();
  probe.markdownRenders = 0;
});
afterEach(() => {
  cleanup();
  useChatStore.setState(initialChatState, true);
  useTasksStore.setState(initialTasksState, true);
  useRuntimeStore.getState().clearAll();
});

describe('ChatView rendering isolation', () => {
  it('ignores background messages, loading and task-list updates', () => {
    render(<ChatView taskId="visible-task" />);
    expect(probe.markdownRenders).toBe(200);
    probe.markdownRenders = 0;
    act(() => {
      useChatStore.getState().addMessage('background-task', makeMessage('background', 'background-task'));
      useChatStore.setState({ loadingTasks: new Set(['background-task']) });
      useTasksStore.setState((state) => ({ tasks: [...state.tasks] }));
    });
    expect(probe.markdownRenders).toBe(0);
    expect(screen.getByRole('heading', { name: 'Result 199' })).toBeInTheDocument();
  });

  it('updates runtime status without reparsing existing Markdown', () => {
    render(<ChatView taskId="visible-task" />);
    expect(probe.markdownRenders).toBe(200);
    probe.markdownRenders = 0;
    act(() => useRuntimeStore.getState().setStatus({ taskId: 'visible-task', replyInProgress: true, replyTo: 'prompt', statusLine: 'Running tests' }));
    expect(screen.getByText('Running tests')).toBeInTheDocument();
    expect(probe.markdownRenders).toBe(0);
  });

  it('renders new and changed content and follows the selected task', () => {
    const view = render(<ChatView taskId="visible-task" />);
    expect(probe.markdownRenders).toBe(200);
    probe.markdownRenders = 0;
    act(() => useChatStore.getState().addMessage('visible-task', makeMessage('new')));
    expect(screen.getByRole('heading', { name: 'Result new' })).toBeInTheDocument();
    expect(probe.markdownRenders).toBe(1);
    probe.markdownRenders = 0;
    act(() => useChatStore.getState().updateMessage('visible-task', { ...makeMessage('new'), content: 'Updated answer' }));
    expect(screen.getByText('Updated answer')).toBeInTheDocument();
    expect(probe.markdownRenders).toBe(1);
    act(() => useChatStore.getState().addMessage('background-task', makeMessage('background', 'background-task')));
    view.rerender(<ChatView taskId="background-task" />);
    expect(screen.getByRole('heading', { name: 'Result background' })).toBeInTheDocument();
    expect(screen.queryByText('Updated answer')).not.toBeInTheDocument();
  });
});
