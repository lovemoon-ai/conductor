import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/shared/types';
import { TaskGraphView } from './TaskGraphView';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

const createTask = (overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
  id: overrides.id,
  title: overrides.title,
  projectId: 'project-1',
  issueId: null,
  status: 'running',
  metadata: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('TaskGraphView', () => {
  beforeEach(() => {
    pushMock.mockReset();
    window.localStorage.clear();
  });

  it('renders graph nodes as title-only cards', () => {
    render(<TaskGraphView tasks={[createTask({ id: 'task-1', title: 'Build graph UI' })]} />);

    expect(screen.getByText('Build graph UI')).toBeInTheDocument();
    expect(screen.queryByText('running')).toBeNull();
    expect(screen.queryByText('project-1')).toBeNull();
  });

  it('moves a node by dragging without opening the task', async () => {
    const onOpenTask = vi.fn();
    render(
      <TaskGraphView
        tasks={[createTask({ id: 'task-1', title: 'Draggable task' })]}
        onOpenTask={onOpenTask}
      />,
    );

    const node = screen.getByTestId('task-graph-node-task-1');
    expect(node).toHaveStyle({ left: '72px', top: '72px' });

    fireEvent.pointerDown(node, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 150, clientY: 130 });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 150, clientY: 130 });

    await waitFor(() => {
      expect(node).toHaveStyle({ left: '122px', top: '102px' });
    });
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('opens a task when a node is activated without dragging', () => {
    const onOpenTask = vi.fn();
    render(
      <TaskGraphView
        tasks={[createTask({ id: 'task-1', title: 'Openable task' })]}
        onOpenTask={onOpenTask}
      />,
    );

    const node = screen.getByTestId('task-graph-node-task-1');
    fireEvent.pointerDown(node, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(onOpenTask).toHaveBeenCalledWith('task-1');
  });

  it('creates a manual edge by selecting a connector and target node', async () => {
    const onOpenTask = vi.fn();
    render(
      <TaskGraphView
        tasks={[
          createTask({ id: 'task-1', title: 'Source task' }),
          createTask({ id: 'task-2', title: 'Target task' }),
        ]}
        onOpenTask={onOpenTask}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start connection from Source task' }));
    const target = screen.getByTestId('task-graph-node-task-2');
    fireEvent.pointerDown(target, { pointerId: 2, button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 120, clientY: 120 });

    await waitFor(() => {
      expect(screen.getByTestId('task-graph-edge-manual-task-1-task-2')).toBeInTheDocument();
    });
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('restores dragged positions and manual edges for the same graph state key', async () => {
    const tasks = [
      createTask({ id: 'task-1', title: 'Source task' }),
      createTask({ id: 'task-2', title: 'Target task' }),
    ];
    const { unmount } = render(
      <TaskGraphView
        tasks={tasks}
        stateKey="projects:project-1"
      />,
    );

    const source = screen.getByTestId('task-graph-node-task-1');
    fireEvent.pointerDown(source, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(source, { pointerId: 1, clientX: 150, clientY: 130 });
    fireEvent.pointerUp(source, { pointerId: 1, clientX: 150, clientY: 130 });

    fireEvent.click(screen.getByRole('button', { name: 'Start connection from Source task' }));
    const target = screen.getByTestId('task-graph-node-task-2');
    fireEvent.pointerDown(target, { pointerId: 2, button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 120, clientY: 120 });

    await waitFor(() => {
      expect(screen.getByTestId('task-graph-edge-manual-task-1-task-2')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(window.localStorage.getItem('conductor:task-graph-state:v1:projects%3Aproject-1')).toContain(
        '"sourceId":"task-1"',
      );
    });

    unmount();
    render(
      <TaskGraphView
        tasks={tasks}
        stateKey="projects:project-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('task-graph-node-task-1')).toHaveStyle({ left: '122px', top: '102px' });
    });
    expect(screen.getByTestId('task-graph-edge-manual-task-1-task-2')).toBeInTheDocument();
  });

  it('keeps saved manual edges when connected tasks are temporarily filtered out', async () => {
    const tasks = [
      createTask({ id: 'task-1', title: 'Source task' }),
      createTask({ id: 'task-2', title: 'Target task' }),
    ];
    const { rerender } = render(
      <TaskGraphView
        tasks={tasks}
        stateKey="projects:project-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start connection from Source task' }));
    const target = screen.getByTestId('task-graph-node-task-2');
    fireEvent.pointerDown(target, { pointerId: 2, button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 120, clientY: 120 });

    await waitFor(() => {
      expect(screen.getByTestId('task-graph-edge-manual-task-1-task-2')).toBeInTheDocument();
    });

    rerender(
      <TaskGraphView
        tasks={[tasks[0]]}
        stateKey="projects:project-1"
      />,
    );
    expect(screen.queryByTestId('task-graph-edge-manual-task-1-task-2')).toBeNull();

    rerender(
      <TaskGraphView
        tasks={tasks}
        stateKey="projects:project-1"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('task-graph-edge-manual-task-1-task-2')).toBeInTheDocument();
    });
  });

  it('zooms with the toolbar controls', async () => {
    render(<TaskGraphView tasks={[createTask({ id: 'task-1', title: 'Zoomable task' })]} />);

    const stage = screen.getByTestId('task-graph-stage');
    expect(stage).toHaveStyle({ transform: 'translate(32px, 32px) scale(1)' });

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in task graph' }));
    await waitFor(() => {
      expect(stage.style.transform).toContain('scale(1.15)');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out task graph' }));
    await waitFor(() => {
      expect(stage.style.transform).toMatch(/scale\(0\.97/);
    });
  });
});
