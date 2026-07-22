import type { Task } from '@/shared/types';
import type { TaskType } from '@/lib/tasks/task-config';
import { orderTasksWithPinnedFirst } from '../store';
import {
  buildTaskCardRows,
  projectTaskCardGroups,
  type TaskCardGroup,
} from './task-card-groups';
import {
  filterTasksByProject,
  getStableTaskBackend,
  resolveTaskDaemonHost,
} from './task-filter';

export type TaskListNavigationOptions = {
  projectFilter?: string | string[] | null;
  hiddenProjectIds?: string[];
  runningOnly?: boolean;
  taskTypeFilter?: TaskType | null;
  daemonHostFilter?: string | null;
  backendFilter?: string | null;
  projectDaemonHostMap?: Map<string, string | null> | null;
};

export type TaskListNavigation = {
  /** One task per row in the order currently shown by the task list. */
  tasks: Task[];
  /** Every visible grouped task points to the tab currently shown for its row. */
  activeTaskIdByTaskId: Map<string, string>;
};

/**
 * Rebuild the mobile task list's linear navigation order.
 *
 * Filters and pin ordering mirror TaskList. Merged task cards contribute only
 * their locally selected tab, so title swipes never expose a hidden tab as a
 * separate previous/next item.
 */
export const buildTaskListNavigation = (
  tasks: Task[],
  groups: TaskCardGroup[],
  options: TaskListNavigationOptions = {},
): TaskListNavigation => {
  const attachedPtyTaskIds = new Set<string>();
  for (const task of tasks) {
    const ptyTaskId = task.attachedTerminal?.ptyTaskId;
    if (ptyTaskId) attachedPtyTaskIds.add(ptyTaskId);
  }

  const tasksWithoutAttachedPty = attachedPtyTaskIds.size > 0
    ? tasks.filter((task) => !attachedPtyTaskIds.has(task.id))
    : tasks;
  const projectVisibleTasks = filterTasksByProject(
    tasksWithoutAttachedPty,
    options.projectFilter,
    options.hiddenProjectIds,
  );
  const runningFilteredTasks = options.runningOnly
    ? projectVisibleTasks.filter((task) => task.status === 'running' || task.status === 'killing')
    : projectVisibleTasks;
  const typeFilteredTasks = options.taskTypeFilter
    ? runningFilteredTasks.filter(
        (task) => (task.taskType ?? 'ai_task') === options.taskTypeFilter,
      )
    : runningFilteredTasks;
  const daemonFilteredTasks = options.daemonHostFilter
    ? typeFilteredTasks.filter(
        (task) => resolveTaskDaemonHost(task, options.projectDaemonHostMap) === options.daemonHostFilter,
      )
    : typeFilteredTasks;
  const backendFilteredTasks = options.backendFilter
    ? daemonFilteredTasks.filter((task) => getStableTaskBackend(task) === options.backendFilter)
    : daemonFilteredTasks;
  const orderedTasks = orderTasksWithPinnedFirst(backendFilteredTasks);
  const taskById = new Map(orderedTasks.map((task) => [task.id, task] as const));
  const visibleTaskIdSet = new Set(taskById.keys());
  const renderGroups = projectTaskCardGroups(groups, (taskId) => visibleTaskIdSet.has(taskId));
  const activeTaskIdByTaskId = new Map<string, string>();

  for (const group of renderGroups) {
    for (const taskId of group.taskIds) {
      activeTaskIdByTaskId.set(taskId, group.activeTaskId);
    }
  }

  const navigationTasks = buildTaskCardRows(orderedTasks, renderGroups).flatMap((row) => {
    if (row.type === 'task') return [row.task];
    const activeTask = taskById.get(row.group.activeTaskId);
    return activeTask ? [activeTask] : [];
  });

  return {
    tasks: navigationTasks,
    activeTaskIdByTaskId,
  };
};
