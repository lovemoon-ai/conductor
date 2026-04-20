import type { Task } from '@/shared/types';

export function filterTasksByProject(
  tasks: Task[],
  projectId: string | null | undefined,
  hiddenProjectIds: string[] = [],
): Task[] {
  const normalizedProjectId = projectId?.trim() || null;
  const hiddenProjectIdSet = new Set(hiddenProjectIds.map((id) => id.trim()).filter(Boolean));

  if (normalizedProjectId) {
    if (hiddenProjectIdSet.has(normalizedProjectId)) {
      return [];
    }
    return tasks.filter((task) => task.projectId === normalizedProjectId);
  }

  if (hiddenProjectIdSet.size === 0) {
    return tasks;
  }
  return tasks.filter((task) => !task.projectId || !hiddenProjectIdSet.has(task.projectId));
}
