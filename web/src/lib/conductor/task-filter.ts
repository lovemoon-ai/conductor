import type { Task } from './types';

export function filterTasksByProject(tasks: Task[], projectId: string | null | undefined): Task[] {
  if (!projectId) {
    return tasks;
  }
  return tasks.filter((task) => task.projectId === projectId);
}
