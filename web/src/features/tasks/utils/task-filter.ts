import type { Task } from '@/shared/types';

/**
 * Resolve the daemon host responsible for a task, falling back across the
 * sources in the order that gives the most useful display value:
 *
 *  1. `task.metadata.daemonName` — populated by the daemon as it registers
 *     the task and is the only reliable signal for tasks attached to the
 *     server-side "Default Project" (which has no `daemonHost` of its own,
 *     so per-project lookup would always return `null`).
 *  2. `task.executionHost` — set when an agent claims/resumes a task; may
 *     differ from `agentHost` after a fire takeover.
 *  3. `task.agentHost` — the daemon that originally created the task.
 *  4. `project.daemonHost` — owner of the task's project; the original
 *     pre-default-project behaviour.
 *
 * Callers that only have project-side data can pass either a project lookup
 * `Map<projectId, daemonHost>` or `null` to skip step 4.
 */
export function resolveTaskDaemonHost(
  task: Pick<Task, 'projectId' | 'agentHost' | 'executionHost' | 'metadata'>,
  projectDaemonHostMap: Map<string, string | null> | null = null,
): string | null {
  const meta = task.metadata as Record<string, unknown> | null | undefined;
  const fromMetadata = typeof meta?.daemonName === 'string' ? meta.daemonName.trim() : '';
  if (fromMetadata) return fromMetadata;
  const fromExecution = typeof task.executionHost === 'string' ? task.executionHost.trim() : '';
  if (fromExecution) return fromExecution;
  const fromAgent = typeof task.agentHost === 'string' ? task.agentHost.trim() : '';
  if (fromAgent) return fromAgent;
  if (projectDaemonHostMap && task.projectId) {
    const fromProject = projectDaemonHostMap.get(task.projectId);
    if (typeof fromProject === 'string' && fromProject.trim()) return fromProject.trim();
  }
  return null;
}

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

/**
 * Resolve the project a task should be *displayed* under. A display-only
 * `secondProjectId` (set only on default-project tasks that were "moved" via
 * the task-card swipe menu) overrides the real `projectId` for grouping,
 * without changing any runtime behaviour. Returns `null` when neither is set.
 */
export function resolveTaskDisplayProjectId(
  task: Pick<Task, 'projectId' | 'secondProjectId'>,
): string | null {
  const second = typeof task.secondProjectId === 'string' ? task.secondProjectId.trim() : '';
  if (second) return second;
  const primary = typeof task.projectId === 'string' ? task.projectId.trim() : '';
  return primary || null;
}

/**
 * Filter tasks by project scope.
 *
 * `projectFilter` accepts:
 *  - `null | undefined | ''` → no project filter (everything visible, modulo
 *    hidden projects).
 *  - `string` → single project; only tasks attached to that exact projectId
 *    pass.
 *  - `string[]` → cross-daemon merged-group view; tasks attached to any of
 *    the member projectIds pass. Used by the merged-project task list so a
 *    single logical "project" shows tasks from every daemon's same-named
 *    project together.
 */
export function filterTasksByProject(
  tasks: Task[],
  projectFilter: string | string[] | null | undefined,
  hiddenProjectIds: string[] = [],
): Task[] {
  const hiddenProjectIdSet = new Set(hiddenProjectIds.flatMap((id) => {
    const trimmed = id.trim();
    return trimmed ? [trimmed] : [];
  }));

  const rawIds = Array.isArray(projectFilter)
    ? projectFilter
    : typeof projectFilter === 'string'
      ? [projectFilter]
      : [];
  const normalizedIds = Array.from(
    new Set(rawIds.flatMap((id) => {
      const trimmed = id.trim();
      return trimmed ? [trimmed] : [];
    })),
  );

  if (normalizedIds.length > 0) {
    const visibleIds = normalizedIds.filter((id) => !hiddenProjectIdSet.has(id));
    if (visibleIds.length === 0) {
      return [];
    }
    const visibleIdSet = new Set(visibleIds);
    return tasks.filter((task) => {
      const displayId = resolveTaskDisplayProjectId(task);
      return !!displayId && visibleIdSet.has(displayId);
    });
  }

  if (hiddenProjectIdSet.size === 0) {
    return tasks;
  }
  return tasks.filter((task) => {
    const displayId = resolveTaskDisplayProjectId(task);
    return !displayId || !hiddenProjectIdSet.has(displayId);
  });
}
