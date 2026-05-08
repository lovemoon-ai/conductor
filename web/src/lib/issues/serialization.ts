import { normalizeIssuePriority, normalizeIssueStatus } from '@/lib/issues/config';
import { serializeTaskResponse } from '@/lib/tasks/serialization';

const parseIssueMetadata = (value: string | null): Record<string, unknown> | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

type SerializableIssue = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority?: string | null;
  position: number;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Optional project attribution — populated when the caller wants the issue's
   * card to show which daemon/project it belongs to (e.g. when the UI is
   * displaying a merged group spanning multiple daemons).
   */
  project?: {
    name?: string | null;
    daemonHost?: string | null;
  } | null;
};

type SerializableActiveTask = Parameters<typeof serializeTaskResponse>[0] | null | undefined;
type SerializableLinkedTask = Parameters<typeof serializeTaskResponse>[0] | null | undefined;
type SerializableTaskList = Parameters<typeof serializeTaskResponse>[0][] | null | undefined;

export const serializeIssue = (
  issue: SerializableIssue,
  activeTask?: SerializableActiveTask,
  linkedTask?: SerializableLinkedTask,
  tasks?: SerializableTaskList,
) => {
  const status = normalizeIssueStatus(issue.status);
  const priority = normalizeIssuePriority(issue.priority);
  const createdAt = issue.createdAt.toISOString();
  const updatedAt = issue.updatedAt.toISOString();
  const serializedActiveTask = activeTask ? serializeTaskResponse(activeTask) : null;
  const resolvedLinkedTask = linkedTask ?? activeTask ?? null;
  const serializedLinkedTask = resolvedLinkedTask ? serializeTaskResponse(resolvedLinkedTask) : null;
  const serializedTasks = Array.isArray(tasks)
    ? tasks.map((task) => serializeTaskResponse(task))
    : null;

  const projectName = issue.project?.name ?? null;
  const daemonHost = issue.project?.daemonHost ?? null;

  return {
    id: issue.id,
    projectId: issue.projectId,
    projectName,
    daemonHost,
    title: issue.title,
    description: issue.description,
    status,
    priority,
    position: issue.position,
    metadata: parseIssueMetadata(issue.metadata),
    activeTask: serializedActiveTask,
    linkedTask: serializedLinkedTask,
    tasks: serializedTasks,
    createdAt,
    updatedAt,
    project_id: issue.projectId,
    project_name: projectName,
    daemon_host: daemonHost,
    active_task: serializedActiveTask,
    linked_task: serializedLinkedTask,
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

export { parseIssueMetadata };
