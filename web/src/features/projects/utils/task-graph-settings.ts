import type { Project } from '@/shared/types';

export const TASK_GRAPH_ENABLED_METADATA_KEY = 'taskGraphEnabled';
const LEGACY_TASK_GRAPH_ENABLED_METADATA_KEY = 'task_graph_enabled';

const readMetadataRecord = (project: Project): Record<string, unknown> =>
  project.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata)
    ? (project.metadata as Record<string, unknown>)
    : {};

export const isProjectTaskGraphEnabled = (project: Project | null | undefined): boolean => {
  if (!project) return false;
  const metadata = readMetadataRecord(project);
  return metadata[TASK_GRAPH_ENABLED_METADATA_KEY] === true
    || metadata[LEGACY_TASK_GRAPH_ENABLED_METADATA_KEY] === true;
};

export const buildMetadataWithTaskGraphEnabled = (
  project: Project,
  enabled: boolean,
): Record<string, unknown> => {
  const metadata = { ...readMetadataRecord(project) };
  delete metadata[LEGACY_TASK_GRAPH_ENABLED_METADATA_KEY];
  metadata[TASK_GRAPH_ENABLED_METADATA_KEY] = enabled;
  return metadata;
};
