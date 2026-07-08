import type { Project, ProjectGroup } from '@/shared/types';
import { computeProjectGroups } from './project-groups';

interface ProjectListVisibilityOptions {
  hiddenProjectIds?: string[];
  showHiddenProjects?: boolean;
  onlineDaemonHosts?: Iterable<string>;
}

interface ProjectListVisibility {
  hiddenProjectIdSet: Set<string>;
  onlineProjects: Project[];
  visibleProjects: Project[];
  visibleGroups: ProjectGroup[];
}

const getProjectDaemonHost = (project: Project): string | null => {
  if (typeof project.daemonHost !== 'string') {
    return null;
  }
  return project.daemonHost.trim() || null;
};

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

const normalizeOnlineDaemonHosts = (hosts?: Iterable<string>): Set<string> => {
  const out = new Set<string>();
  if (!hosts) {
    return out;
  }
  for (const host of hosts) {
    const trimmed = host.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return out;
};

export const getProjectListVisibility = (
  projects: Project[],
  options: ProjectListVisibilityOptions = {},
): ProjectListVisibility => {
  const onlineDaemonHosts = normalizeOnlineDaemonHosts(options.onlineDaemonHosts);
  const hiddenProjectIdSet = new Set(options.hiddenProjectIds ?? []);
  const duplicateSoloCollaborationProjectIds = getDuplicateSoloCollaborationProjectIds(projects);

  const onlineProjects = projects.filter((project) => {
    if (duplicateSoloCollaborationProjectIds.has(project.id)) {
      return false;
    }
    const daemonHost = getProjectDaemonHost(project);
    const hasCollaboration = Boolean(project.collaborationId || project.collaboration);
    return !daemonHost || onlineDaemonHosts.has(daemonHost) || hasCollaboration;
  });

  const visibleProjects = onlineProjects.filter(
    (project) => options.showHiddenProjects || !hiddenProjectIdSet.has(project.id),
  );

  return {
    hiddenProjectIdSet,
    onlineProjects,
    visibleProjects,
    visibleGroups: computeProjectGroups(visibleProjects),
  };
};

export const getVisibleProjectGroupsForProjectList = (
  projects: Project[],
  options: ProjectListVisibilityOptions = {},
): ProjectGroup[] => getProjectListVisibility(projects, options).visibleGroups;
