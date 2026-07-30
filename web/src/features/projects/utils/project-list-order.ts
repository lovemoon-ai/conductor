import type { Project, ProjectGroup } from '@/shared/types';
import { computeProjectGroups } from './project-groups';

interface ProjectListVisibilityOptions {
  hiddenProjectIds?: string[];
  showHiddenProjects?: boolean;
}

interface ProjectListVisibility {
  hiddenProjectIdSet: Set<string>;
  /** Projects eligible to be displayed (excludes stale solo-collaboration duplicates only). */
  candidateProjects: Project[];
  visibleProjects: Project[];
  visibleGroups: ProjectGroup[];
}

const getCollaborationMemberCount = (project: Project): number =>
  project.collaboration?.memberCount ?? project.collaboration?.members.length ?? 0;

const getProjectWorkspaceKey = (project: Project): string | null => {
  const workspacePath = typeof project.workspacePath === 'string'
    ? project.workspacePath.trim().replace(/\/+$/, '')
    : '';
  const name = project.name.trim();
  if (!workspacePath || !name) {
    return null;
  }
  return `${name}\u0000${workspacePath}`;
};

export const getDuplicateSoloCollaborationProjectIds = (projects: Project[]): Set<string> => {
  const sharedKeys = new Set<string>();
  for (const project of projects) {
    const key = getProjectWorkspaceKey(project);
    if (key && getCollaborationMemberCount(project) > 1) {
      sharedKeys.add(key);
    }
  }

  const duplicateIds = new Set<string>();
  for (const project of projects) {
    const key = getProjectWorkspaceKey(project);
    if (
      key
      && sharedKeys.has(key)
      && Boolean(project.collaborationId || project.collaboration)
      && getCollaborationMemberCount(project) <= 1
    ) {
      duplicateIds.add(project.id);
    }
  }
  return duplicateIds;
};

export const getProjectListVisibility = (
  projects: Project[],
  options: ProjectListVisibilityOptions = {},
): ProjectListVisibility => {
  const hiddenProjectIdSet = new Set(options.hiddenProjectIds ?? []);
  const duplicateSoloCollaborationProjectIds = getDuplicateSoloCollaborationProjectIds(projects);

  // Daemon-bound projects remain visible even when their daemon is offline;
  // the card renders a gray indicator instead of hiding the project. Only
  // stale solo-collaboration duplicates are dropped from the candidate list.
  const candidateProjects = projects.filter((project) =>
    !duplicateSoloCollaborationProjectIds.has(project.id),
  );

  const visibleProjects = candidateProjects.filter(
    (project) => options.showHiddenProjects || !hiddenProjectIdSet.has(project.id),
  );

  return {
    hiddenProjectIdSet,
    candidateProjects,
    visibleProjects,
    visibleGroups: computeProjectGroups(visibleProjects),
  };
};

export const getVisibleProjectGroupsForProjectList = (
  projects: Project[],
  options: ProjectListVisibilityOptions = {},
): ProjectGroup[] => getProjectListVisibility(projects, options).visibleGroups;
