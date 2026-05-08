import type { Project, ProjectGroup } from '@/shared/types';

export const reorderProjectsLocally = (
  projects: Project[],
  activeId: string,
  overId: string,
): Project[] => {
  const activeIndex = projects.findIndex((project) => project.id === activeId);
  if (activeIndex === -1) {
    return projects;
  }

  const overIndex = projects.findIndex((project) => project.id === overId);
  if (overIndex === -1 || overIndex === activeIndex) {
    return projects;
  }

  const next = [...projects];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next;
};

/**
 * Group-aware variant of `reorderProjectsLocally`. Groups are addressed by
 * their `key` and entire groups (including all daemon members) move together.
 */
export const reorderProjectGroupsLocally = (
  groups: ProjectGroup[],
  activeId: string,
  overId: string,
): ProjectGroup[] => {
  const activeIndex = groups.findIndex((group) => group.key === activeId);
  if (activeIndex === -1) {
    return groups;
  }
  const overIndex = groups.findIndex((group) => group.key === overId);
  if (overIndex === -1 || overIndex === activeIndex) {
    return groups;
  }
  const next = [...groups];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next;
};

/**
 * Flatten an ordered list of project groups back into a flat array of project
 * ids, preserving member order within each group. Used to write the new
 * ordering back to `/projects/reorder`, which operates on individual rows.
 */
export const flattenGroupsToProjectIds = (groups: ProjectGroup[]): string[] => {
  const out: string[] = [];
  for (const group of groups) {
    for (const member of group.members) {
      out.push(member.id);
    }
  }
  return out;
};

