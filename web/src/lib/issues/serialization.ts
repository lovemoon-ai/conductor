import { normalizeIssueStatus } from '@/lib/issues/config';
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
  position: number;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SerializableActiveTask = Parameters<typeof serializeTaskResponse>[0] | null | undefined;

export const serializeIssue = (
  issue: SerializableIssue,
  activeTask?: SerializableActiveTask,
) => {
  const status = normalizeIssueStatus(issue.status);
  const createdAt = issue.createdAt.toISOString();
  const updatedAt = issue.updatedAt.toISOString();
  const serializedActiveTask = activeTask ? serializeTaskResponse(activeTask) : null;

  return {
    id: issue.id,
    projectId: issue.projectId,
    title: issue.title,
    description: issue.description,
    status,
    position: issue.position,
    metadata: parseIssueMetadata(issue.metadata),
    activeTask: serializedActiveTask,
    createdAt,
    updatedAt,
    project_id: issue.projectId,
    active_task: serializedActiveTask,
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

export { parseIssueMetadata };
