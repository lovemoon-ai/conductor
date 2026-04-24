import type { Task } from '@/shared/types';

/**
 * Derive the backend name for a task using only stable, persistent sources
 * (so display and filter agree without depending on ephemeral runtime state).
 * Order mirrors the fallback chain used in TaskItem for the backend chip.
 */
export function getStableTaskBackend(task: Task): string | null {
  if (typeof task.backendType === 'string' && task.backendType.trim()) {
    return task.backendType.trim();
  }
  const metadata = task.metadata as Record<string, unknown> | null | undefined;
  if (metadata && typeof metadata.backendType === 'string' && metadata.backendType.trim()) {
    return metadata.backendType.trim();
  }
  const launchConfig = task.launchConfig as Record<string, unknown> | null | undefined;
  if (launchConfig && typeof launchConfig.toolPreset === 'string' && launchConfig.toolPreset.trim()) {
    return launchConfig.toolPreset.trim();
  }
  return null;
}

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
