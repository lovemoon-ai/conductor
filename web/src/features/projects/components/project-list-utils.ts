import type { Project } from '@/shared/types';

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

