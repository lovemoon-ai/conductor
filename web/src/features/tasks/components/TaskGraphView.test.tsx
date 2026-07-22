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

  const dragNodeOnto = (draggedTestId: string, target: HTMLElement) => {
    const dragged = screen.getByTestId(draggedTestId);
    const draggedLeft = Number.parseFloat((dragged as HTMLElement).style.left || '0');
    const draggedTop = Number.parseFloat((dragged as HTMLElement).style.top || '0');
    const targetLeft = Number.parseFloat((target as HTMLElement).style.left || '0');
    const targetTop = Number.parseFloat((target as HTMLElement).style.top || '0');
    // At scale 1 the client delta equals the world delta, so moving by
    // (targetLeft - draggedLeft, targetTop - draggedTop) parks the dragged card
    // directly on top of the target and its centre lands inside the target rect.
    const deltaX = targetLeft - draggedLeft;
    const deltaY = targetTop - draggedTop;
    fireEvent.pointerDown(dragged, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(dragged, { pointerId: 1, clientX: deltaX, clientY: deltaY });
    fireEvent.pointerUp(dragged, { pointerId: 1, clientX: deltaX, clientY: deltaY });
  };

  const mergeTaskOnto = (draggedTestId: string, targetTestId: string) =>
    dragNodeOnto(draggedTestId, screen.getByTestId(targetTestId));

  it('merges two cards into a tab card and switches the active tab', async () => {
    const onOpenTask = vi.fn();
    render(
      <TaskGraphView
        tasks={[
          createTask({ id: 'task-1', title: 'First task' }),
          createTask({ id: 'task-2', title: 'Second task' }),
        ]}
        onOpenTask={onOpenTask}
      />,
    );

    mergeTaskOnto('task-graph-node-task-2', 'task-graph-node-task-1');

    // A tab card appears and the individual nodes are gone.
    const group = await screen.findByTestId(/task-graph-group-group-/);
    expect(screen.queryByTestId('task-graph-node-task-1')).toBeNull();
    expect(screen.queryByTestId('task-graph-node-task-2')).toBeNull();

    // Default ordinal tab labels 0/1 are shown; the dropped card is on top.
    const tabs = group.querySelectorAll('[data-group-tab="true"]');
    expect(tabs).toHaveLength(2);
    expect(screen.getByText('Second task')).toBeInTheDocument();
    expect(screen.queryByText('First task')).toBeNull();

    // Clicking the first tab brings task-1 to the front.
    const firstTab = group.querySelector('[data-task-id="task-1"]') as HTMLElement;
    fireEvent.pointerDown(firstTab, { pointerId: 2, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(firstTab, { pointerId: 2, clientX: 5, clientY: 5 });

    await waitFor(() => {
      expect(screen.getByText('First task')).toBeInTheDocument();
    });
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('renames a tab title in place via double-click', async () => {
    render(
      <TaskGraphView
        tasks={[
          createTask({ id: 'task-1', title: 'First task' }),
          createTask({ id: 'task-2', title: 'Second task' }),
        ]}
      />,
    );

    mergeTaskOnto('task-graph-node-task-2', 'task-graph-node-task-1');
    const group = await screen.findByTestId(/task-graph-group-group-/);

    const firstTab = group.querySelector('[data-task-id="task-1"]') as HTMLElement;
    fireEvent.doubleClick(firstTab);

    const input = group.querySelector('input') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Design' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(group.querySelector('[data-task-id="task-1"]')?.textContent).toContain('Design');
    });
  });

  it('ejects a tab and dissolves the tab card back into nodes', async () => {
    render(
      <TaskGraphView
        tasks={[
          createTask({ id: 'task-1', title: 'First task' }),
          createTask({ id: 'task-2', title: 'Second task' }),
        ]}
      />,
    );

    mergeTaskOnto('task-graph-node-task-2', 'task-graph-node-task-1');
    const group = await screen.findByTestId(/task-graph-group-group-/);

    const removeButton = group.querySelector(
      '[data-task-id="task-2"] button[data-group-no-drag="true"]',
    ) as HTMLElement;
    fireEvent.click(removeButton);

    // With only one tab left the tab card dissolves; both cards are nodes again.
    await waitFor(() => {
      expect(screen.getByTestId('task-graph-node-task-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('task-graph-node-task-2')).toBeInTheDocument();
    expect(screen.queryByTestId(/task-graph-group-group-/)).toBeNull();
  });

  it('persists a merged tab card for the same graph state key', async () => {
    const tasks = [
      createTask({ id: 'task-1', title: 'First task' }),
      createTask({ id: 'task-2', title: 'Second task' }),
    ];
    const { unmount } = render(
      <TaskGraphView tasks={tasks} stateKey="projects:project-1" />,
    );

    mergeTaskOnto('task-graph-node-task-2', 'task-graph-node-task-1');
    await screen.findByTestId(/task-graph-group-group-/);

    await waitFor(() => {
      expect(
        window.localStorage.getItem('conductor:task-graph-state:v1:projects%3Aproject-1'),
      ).toContain('"taskIds":["task-1","task-2"]');
    });

    unmount();
    render(<TaskGraphView tasks={tasks} stateKey="projects:project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId(/task-graph-group-group-/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('task-graph-node-task-1')).toBeNull();
  });

  it('keeps default tab ordinals fixed when a middle tab is filtered out', async () => {
    const tasks = [
      createTask({ id: 'task-1', title: 'First task' }),
      createTask({ id: 'task-2', title: 'Second task' }),
      createTask({ id: 'task-3', title: 'Third task' }),
    ];
    const { rerender } = render(<TaskGraphView tasks={tasks} />);

    mergeTaskOnto('task-graph-node-task-2', 'task-graph-node-task-1');
    const group = await screen.findByTestId(/task-graph-group-group-/);
    dragNodeOnto('task-graph-node-task-3', group);

    await waitFor(() => {
      expect(group.querySelectorAll('[data-group-tab="true"]')).toHaveLength(3);
    });
    expect(group.querySelector('[data-task-id="task-1"]')?.textContent).toContain('0');
    expect(group.querySelector('[data-task-id="task-3"]')?.textContent).toContain('2');

    // Filter out the middle tab: the surviving tabs keep their original numbers
    // (0 and 2) rather than renumbering to 0/1.
    rerender(<TaskGraphView tasks={[tasks[0], tasks[2]]} />);

    await waitFor(() => {
      expect(group.querySelectorAll('[data-group-tab="true"]')).toHaveLength(2);
    });
    expect(group.querySelector('[data-task-id="task-1"]')?.textContent).toContain('0');
    expect(group.querySelector('[data-task-id="task-3"]')?.textContent).toContain('2');
  });

  it('clears an in-progress tab rename when the tab card dissolves', async () => {
    render(
      <TaskGraphView
        tasks={[
          createTask({ id: 'task-1', title: 'First task' }),
          createTask({ id: 'task-2', title: 'Second task' }),
        ]}
      />,
    );

    mergeTaskOnto('task-graph-node-task-2', 'task-graph-node-task-1');
    const group = await screen.findByTestId(/task-graph-group-group-/);

    fireEvent.doubleClick(group.querySelector('[data-task-id="task-1"]') as HTMLElement);
    expect(group.querySelector('input')).toBeInTheDocument();

    // Ejecting the other tab dissolves the card; the dangling edit box must go.
    const removeButton = group.querySelector(
      '[data-task-id="task-2"] button[data-group-no-drag="true"]',
    ) as HTMLElement;
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(screen.getByTestId('task-graph-node-task-1')).toBeInTheDocument();
    });
    expect(document.querySelector('input')).toBeNull();
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
