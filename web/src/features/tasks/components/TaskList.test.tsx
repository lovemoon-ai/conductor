import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskList } from './TaskList';

const stubRect = (el: HTMLElement, top: number, bottom: number) => {
  el.getBoundingClientRect = () => ({
    top,
    bottom,
    left: 0,
    right: 300,
    x: 0,
    y: top,
    width: 300,
    height: bottom - top,
    toJSON: () => ({}),
  }) as DOMRect;
};

// Drag a card by a blank area, vertically (dominant axis) onto the target row so
// the merge gesture activates past its threshold.
const dragCardOnto = (fromTaskId: string, fromTop: number, toTop: number) => {
  const wrapper = document.querySelector(`[data-task-item-wrapper="${fromTaskId}"]`) as HTMLElement;
  fireEvent.pointerDown(wrapper, { pointerId: 1, button: 0, clientX: 20, clientY: fromTop + 10 });
  fireEvent.pointerMove(wrapper, { pointerId: 1, clientX: 20, clientY: toTop + 10 });
  fireEvent.pointerUp(wrapper, { pointerId: 1, clientX: 20, clientY: toTop + 10 });
};

const deleteTaskMock = vi.fn();
const taskItemMock = vi.fn();
const taskGraphViewMock = vi.fn();

type FakeTask = {
  id: string;
  title: string;
  projectId: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  agentHost?: string | null;
  executionHost?: string | null;
};

let tasksState: {
  tasks: FakeTask[];
  isLoading: boolean;
  unreadTaskIds: Set<string>;
  currentProjectFilter: string | null;
  deleteTask: typeof deleteTaskMock;
};
let projectsState: {
  projects: Array<{ id: string; name: string; daemonHost?: string | null }>;
  hiddenProjectIds: string[];
};

vi.mock('../store', () => ({
  orderTasksWithPinnedFirst: <T extends { metadata?: Record<string, unknown> | null }>(tasks: T[]): T[] =>
    tasks
      .map((task, index) => {
        const value = task.metadata?.pinnedAt;
        const pinnedAt = typeof value === 'string' && Number.isFinite(Date.parse(value))
          ? Date.parse(value)
          : null;
        return { task, index, pinnedAt };
      })
      .sort((left, right) => {
        if (left.pinnedAt !== null && right.pinnedAt !== null) {
          const pinnedDelta = right.pinnedAt - left.pinnedAt;
          return pinnedDelta !== 0 ? pinnedDelta : left.index - right.index;
        }
        if (left.pinnedAt !== null) return -1;
        if (right.pinnedAt !== null) return 1;
        return left.index - right.index;
      })
      .map(({ task }) => task),
  useTasksStore: (selector?: (state: typeof tasksState) => unknown) =>
    typeof selector === 'function' ? selector(tasksState) : tasksState,
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

vi.mock('./TaskItem', () => ({
  TaskItem: (props: {
    task: { id: string; title: string; projectId: string | null; status: string };
    isActive?: boolean;
    showProjectName?: boolean;
    showDaemonHost?: boolean;
    projectName?: string | null;
    projectDaemonHost?: string | null;
  }) => {
    taskItemMock(props);
    return (
      <div data-testid={`task-item-${props.task.id}`}>
        {props.task.title}:{props.isActive ? 'active' : 'idle'}
      </div>
    );
  },
}));

vi.mock('./TaskGraphView', () => ({
  TaskGraphView: (props: { tasks: Array<{ id: string; title: string }>; stateKey?: string | null }) => {
    taskGraphViewMock(props);
    return (
      <div data-testid="task-graph-view" data-state-key={props.stateKey ?? ''}>
        graph:{props.tasks.map((task) => task.id).join(',')}
      </div>
    );
  },
}));

vi.mock('@/components/common/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

describe('TaskList', () => {
  const expectFullHeightGraphShell = () => {
    const graphView = screen.getByTestId('task-graph-view');
    expect(graphView.parentElement).toHaveClass('relative', 'h-full', 'min-h-[420px]');
    expect(graphView.parentElement?.parentElement).toHaveClass('min-h-0', 'flex-1');
    expect(graphView.parentElement?.parentElement?.parentElement).toHaveClass('flex', 'h-full', 'min-h-0', 'flex-col');
  };

  beforeEach(() => {
    deleteTaskMock.mockReset();
    taskItemMock.mockReset();
    taskGraphViewMock.mockReset();

    tasksState = {
      tasks: [
        { id: 'task-1', title: 'Task One', projectId: 'project-1', status: 'running' },
        { id: 'task-2', title: 'Task Two', projectId: 'project-2', status: 'completed' },
      ],
      isLoading: false,
      unreadTaskIds: new Set(['task-2']),
      currentProjectFilter: 'project-1',
      deleteTask: deleteTaskMock,
    };
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One' },
      ],
      hiddenProjectIds: [],
    };
  });

  it('renders list view badges and items', async () => {
    render(<TaskList viewMode="list" activeTaskId="task-2" />);

    expect(await screen.findByText('Task One:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:active')).not.toBeInTheDocument();
    expect(screen.queryByText('1 unread')).not.toBeInTheDocument();
    expect(screen.queryByText('Project One')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grid view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh tasks' })).toBeNull();
  });

  it('shows loading spinner when loading the initial task set', () => {
    tasksState = {
      ...tasksState,
      tasks: [],
      isLoading: true,
    };

    render(<TaskList viewMode="list" />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('renders graph view with the same filtered tasks', () => {
    tasksState = {
      ...tasksState,
      currentProjectFilter: null,
    };

    render(<TaskList viewMode="graph" projectFilter="project-1" />);

    expect(screen.getByTestId('task-graph-view')).toHaveTextContent('graph:task-1');
    expectFullHeightGraphShell();
    expect(screen.queryByTestId('task-item-task-1')).toBeNull();
    expect(taskGraphViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: 'task-1' })],
        stateKey: 'projects:project-1',
      }),
    );
  });

  it('keeps graph view full-height while loading an empty initial task set', () => {
    tasksState = {
      ...tasksState,
      tasks: [],
      isLoading: true,
    };

    render(<TaskList viewMode="graph" projectFilter="project-1" />);

    expect(screen.getByTestId('task-graph-view')).toHaveTextContent('graph:');
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expectFullHeightGraphShell();
  });

  it('keeps graph view full-height for the empty task state', () => {
    tasksState = {
      ...tasksState,
      tasks: [],
      isLoading: false,
    };

    render(<TaskList viewMode="graph" projectFilter="project-1" />);

    expect(screen.getByTestId('task-graph-view')).toHaveTextContent('graph:');
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expectFullHeightGraphShell();
  });

  it('excludes hidden project tasks from all-project lists', () => {
    tasksState = {
      ...tasksState,
      currentProjectFilter: null,
    };
    projectsState = {
      ...projectsState,
      hiddenProjectIds: ['project-2'],
    };

    render(<TaskList viewMode="list" />);

    expect(screen.getByText('Task One:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:idle')).toBeNull();
  });

  it('hides non-running tasks when runningOnly is enabled', () => {
    tasksState = {
      ...tasksState,
      currentProjectFilter: null,
      tasks: [
        ...tasksState.tasks,
        { id: 'task-3', title: 'Task Three', projectId: 'project-1', status: 'killing' },
      ],
    };

    render(<TaskList viewMode="list" runningOnly />);

    expect(screen.getByText('Task One:idle')).toBeInTheDocument();
    expect(screen.getByText('Task Three:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:idle')).toBeNull();
  });

  it('keeps pinned tasks above updated-at order and sorts pins by pin time', () => {
    tasksState = {
      ...tasksState,
      tasks: [
        {
          id: 'task-unpinned-new',
          title: 'Unpinned New',
          projectId: 'project-1',
          status: 'running',
          metadata: null,
        },
        {
          id: 'task-pinned-old',
          title: 'Pinned Old',
          projectId: 'project-1',
          status: 'running',
          metadata: { pinnedAt: '2024-01-01T00:00:00.000Z' },
        },
        {
          id: 'task-pinned-new',
          title: 'Pinned New',
          projectId: 'project-1',
          status: 'running',
          metadata: { pinnedAt: '2024-01-02T00:00:00.000Z' },
        },
      ],
    };

    render(<TaskList viewMode="list" projectFilter="project-1" />);

    const renderedIds = Array.from(document.querySelectorAll('[data-testid^="task-item-"]'))
      .map((node) => node.getAttribute('data-testid'));
    expect(renderedIds).toEqual([
      'task-item-task-pinned-new',
      'task-item-task-pinned-old',
      'task-item-task-unpinned-new',
    ]);
  });

  describe('project name / daemon host chip visibility', () => {
    const lastPropsFor = (taskId: string) => {
      const calls = taskItemMock.mock.calls.filter(
        ([call]: Array<{ task: { id: string } }>) => call.task.id === taskId,
      );
      const [latest] = calls[calls.length - 1] ?? [];
      return latest as {
        showProjectName?: boolean;
        showDaemonHost?: boolean;
        projectName?: string | null;
        projectDaemonHost?: string | null;
      } | undefined;
    };

    it('shows both project and daemon chips in the no-filter view (tasks can span projects)', () => {
      tasksState = {
        ...tasksState,
        currentProjectFilter: null,
      };
      projectsState = {
        projects: [
          { id: 'project-1', name: 'Project One', daemonHost: 'daemon-a' },
          { id: 'project-2', name: 'Project Two', daemonHost: 'daemon-b' },
        ],
        hiddenProjectIds: [],
      };

      render(<TaskList viewMode="list" />);

      const props = lastPropsFor('task-1');
      expect(props?.showProjectName).toBe(true);
      expect(props?.showDaemonHost).toBe(true);
      expect(props?.projectName).toBe('Project One');
      expect(props?.projectDaemonHost).toBe('daemon-a');
    });

    it('hides both chips when filtered to a single project on a single daemon (everything redundant)', () => {
      projectsState = {
        projects: [
          { id: 'project-1', name: 'Project One', daemonHost: 'daemon-a' },
        ],
        hiddenProjectIds: [],
      };

      render(<TaskList viewMode="list" projectFilter="project-1" />);

      const props = lastPropsFor('task-1');
      expect(props?.showProjectName).toBe(false);
      expect(props?.showDaemonHost).toBe(false);
      expect(props?.projectName).toBeNull();
      expect(props?.projectDaemonHost).toBeNull();
    });

    it('hides the project chip but keeps the daemon chip in a merged cross-daemon scope (default project case)', () => {
      // Simulates the default project view: same project name on multiple
      // daemons merged into one logical project. The list should help the
      // user tell which daemon each task came from, but the repeated
      // project-name chip would be noise.
      tasksState = {
        ...tasksState,
        tasks: [
          { id: 'task-1', title: 'Task One', projectId: 'project-default-a', status: 'running' },
          { id: 'task-2', title: 'Task Two', projectId: 'project-default-b', status: 'running' },
        ],
        currentProjectFilter: null,
      };
      projectsState = {
        projects: [
          { id: 'project-default-a', name: 'Default', daemonHost: 'daemon-a' },
          { id: 'project-default-b', name: 'Default', daemonHost: 'daemon-b' },
        ],
        hiddenProjectIds: [],
      };

      render(
        <TaskList
          viewMode="list"
          projectFilter={['project-default-a', 'project-default-b']}
        />,
      );

      const taskOneProps = lastPropsFor('task-1');
      const taskTwoProps = lastPropsFor('task-2');
      expect(taskOneProps?.showProjectName).toBe(false);
      expect(taskOneProps?.showDaemonHost).toBe(true);
      expect(taskOneProps?.projectName).toBeNull();
      expect(taskOneProps?.projectDaemonHost).toBe('daemon-a');
      expect(taskTwoProps?.showDaemonHost).toBe(true);
      expect(taskTwoProps?.projectDaemonHost).toBe('daemon-b');
    });

    it('shows daemon chip for Default Project tasks where project.daemonHost is null (uses metadata.daemonName)', () => {
      // The server-side "Default Project" is a single global record with no
      // daemonHost binding. Tasks on it carry the true daemon in
      // `metadata.daemonName`. The chip must still render and the per-card
      // value must come from each task's own metadata, not from the project
      // (which is null for everyone).
      tasksState = {
        ...tasksState,
        tasks: [
          {
            id: 'task-1',
            title: 'Task One',
            projectId: 'default-project',
            status: 'running',
            metadata: { daemonName: 'debug' },
          },
          {
            id: 'task-2',
            title: 'Task Two',
            projectId: 'default-project',
            status: 'running',
            metadata: { daemonName: 'qa-daemon-2' },
          },
        ],
        currentProjectFilter: null,
      };
      projectsState = {
        projects: [
          { id: 'default-project', name: 'Default Project', daemonHost: null },
        ],
        hiddenProjectIds: [],
      };

      render(<TaskList viewMode="list" projectFilter="default-project" />);

      const taskOneProps = lastPropsFor('task-1');
      const taskTwoProps = lastPropsFor('task-2');
      // Single-project filter → project-name chip stays hidden (redundant)…
      expect(taskOneProps?.showProjectName).toBe(false);
      // …but the visible tasks span two daemons, so the daemon chip lights up
      // even though the project itself has no daemonHost.
      expect(taskOneProps?.showDaemonHost).toBe(true);
      expect(taskOneProps?.projectDaemonHost).toBe('debug');
      expect(taskTwoProps?.showDaemonHost).toBe(true);
      expect(taskTwoProps?.projectDaemonHost).toBe('qa-daemon-2');
    });
  });

  describe('tab-card merging (list view)', () => {
    beforeEach(() => {
      window.localStorage.clear();
      tasksState = {
        ...tasksState,
        tasks: [
          { id: 'task-1', title: 'Task One', projectId: 'project-1', status: 'running' },
          { id: 'task-2', title: 'Task Two', projectId: 'project-1', status: 'running' },
        ],
        currentProjectFilter: null,
      };
    });

    const primeRowRects = () => {
      stubRect(document.querySelector('[data-task-item-wrapper="task-1"]') as HTMLElement, 0, 100);
      stubRect(document.querySelector('[data-task-item-wrapper="task-2"]') as HTMLElement, 100, 200);
    };

    it('merges two cards into a tab card and switches the active tab', async () => {
      const onOpenTask = vi.fn();
      render(<TaskList viewMode="list" projectFilter={null} onOpenTask={onOpenTask} />);
      primeRowRects();

      // Drag task-1 down onto task-2 → new tab card, dragged tab on top.
      dragCardOnto('task-1', 0, 100);

      const tabCard = await waitFor(() => {
        const el = document.querySelector('[data-task-tab-card]');
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
      const tabs = tabCard.querySelectorAll('[data-task-tab]');
      expect(tabs).toHaveLength(2);
      // Default ordinal labels follow stored order [task-2, task-1] → 0, 1.
      expect(tabCard.querySelector('[data-task-tab="task-2"]')?.textContent).toContain('0');
      expect(tabCard.querySelector('[data-task-tab="task-1"]')?.textContent).toContain('1');
      // Dropped card (task-1) is the only one rendered in the body.
      expect(screen.getByTestId('task-item-task-1')).toBeInTheDocument();
      expect(screen.queryByTestId('task-item-task-2')).toBeNull();

      // Clicking the other tab brings task-2 to the front AND selects it.
      fireEvent.click(tabCard.querySelector('[data-task-tab="task-2"]') as HTMLElement);
      await waitFor(() => {
        expect(screen.getByTestId('task-item-task-2')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('task-item-task-1')).toBeNull();
      expect(onOpenTask).toHaveBeenCalledWith('task-2');
    });

    it('enters drag state after a touch hold and merges without a separate handle', () => {
      vi.useFakeTimers();
      try {
        render(<TaskList viewMode="list" projectFilter={null} />);
        primeRowRects();

        const wrapper = document.querySelector('[data-task-item-wrapper="task-1"]') as HTMLElement;
        expect(screen.queryByRole('button', { name: /drag task to merge/i })).toBeNull();
        expect(wrapper).toHaveClass('touch-pan-y');

        fireEvent.touchStart(wrapper, {
          touches: [{ identifier: 7, clientX: 20, clientY: 10 }],
        });
        act(() => {
          vi.advanceTimersByTime(450);
        });

        expect(wrapper).toHaveClass('opacity-40');
        expect(screen.getByText('Drop onto a card to merge')).toBeInTheDocument();
        expect(fireEvent.contextMenu(wrapper)).toBe(false);

        const moveWasNotCancelled = fireEvent.touchMove(window, {
          touches: [{ identifier: 7, clientX: 20, clientY: 110 }],
        });
        expect(moveWasNotCancelled).toBe(false);
        fireEvent.touchEnd(wrapper, {
          changedTouches: [{ identifier: 7, clientX: 20, clientY: 110 }],
          touches: [],
        });

        expect(document.querySelector('[data-task-tab-card]')).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps scrolling when touch moves before the long-press threshold', () => {
      vi.useFakeTimers();
      try {
        render(<TaskList viewMode="list" projectFilter={null} />);
        primeRowRects();

        const wrapper = document.querySelector('[data-task-item-wrapper="task-1"]') as HTMLElement;
        fireEvent.touchStart(wrapper, {
          touches: [{ identifier: 8, clientX: 20, clientY: 10 }],
        });
        const moveWasNotCancelled = fireEvent.touchMove(window, {
          touches: [{ identifier: 8, clientX: 20, clientY: 30 }],
        });
        expect(moveWasNotCancelled).toBe(true);
        act(() => {
          vi.advanceTimersByTime(500);
        });

        expect(wrapper).not.toHaveClass('opacity-40');
        expect(document.querySelector('[data-task-tab-card]')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not merge when a long-press drag receives touchcancel', () => {
      vi.useFakeTimers();
      try {
        render(<TaskList viewMode="list" projectFilter={null} />);
        primeRowRects();

        const wrapper = document.querySelector('[data-task-item-wrapper="task-1"]') as HTMLElement;
        fireEvent.touchStart(wrapper, {
          touches: [{ identifier: 9, clientX: 20, clientY: 10 }],
        });
        act(() => {
          vi.advanceTimersByTime(450);
        });
        fireEvent.touchMove(window, {
          touches: [{ identifier: 9, clientX: 20, clientY: 110 }],
        });
        fireEvent.touchCancel(wrapper, { touches: [] });

        expect(document.querySelector('[data-task-tab-card]')).toBeNull();
        expect(wrapper).not.toHaveClass('opacity-40');
      } finally {
        vi.useRealTimers();
      }
    });

    it('renames a tab via long-press and unmerges via double-click', () => {
      vi.useFakeTimers();
      try {
        render(<TaskList viewMode="list" projectFilter={null} />);
        primeRowRects();
        dragCardOnto('task-1', 0, 100);

        const tabCard = document.querySelector('[data-task-tab-card]') as HTMLElement;
        expect(tabCard).not.toBeNull();

        // Press-and-hold task-2's tab → inline rename box.
        const tab2 = tabCard.querySelector('[data-task-tab="task-2"]') as HTMLElement;
        fireEvent.pointerDown(tab2, { button: 0, pointerId: 5, clientX: 5, clientY: 5 });
        act(() => {
          vi.advanceTimersByTime(500);
        });
        const input = tabCard.querySelector('[data-task-tab-input="task-2"]') as HTMLInputElement;
        expect(input).toBeInTheDocument();
        fireEvent.change(input, { target: { value: 'Design' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(tabCard.querySelector('[data-task-tab="task-2"]')?.textContent).toContain('Design');

        // Double-click a tab → unmerge; only one tab remains → the card dissolves.
        fireEvent.doubleClick(tabCard.querySelector('[data-task-tab="task-1"]') as HTMLElement);
        expect(document.querySelector('[data-task-tab-card]')).toBeNull();
        expect(document.querySelector('[data-task-item-wrapper="task-1"]')).not.toBeNull();
        expect(document.querySelector('[data-task-item-wrapper="task-2"]')).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('persists a merged tab card across remounts for the same scope', async () => {
      const { unmount } = render(<TaskList viewMode="list" projectFilter={null} />);
      primeRowRects();
      dragCardOnto('task-1', 0, 100);

      await waitFor(() => {
        expect(document.querySelector('[data-task-tab-card]')).not.toBeNull();
      });

      unmount();
      render(<TaskList viewMode="list" projectFilter={null} />);
      await waitFor(() => {
        expect(document.querySelector('[data-task-tab-card]')).not.toBeNull();
      });
      expect(document.querySelector('[data-task-item-wrapper="task-1"]')).toBeNull();
    });
  });
});
