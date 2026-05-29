'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useProjectsStore } from '@/features/projects';

const DEFAULT_TITLE = 'Conductor';

/**
 * Keeps the browser tab title in sync with the currently selected project.
 * Shows the selected project's name, falling back to "Conductor" when nothing
 * is selected. Renders nothing.
 *
 * The effect also re-runs on pathname changes so the project title is
 * re-applied after any navigation that might set its own document title.
 */
export function ProjectDocumentTitle() {
  const pathname = usePathname();
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const projects = useProjectsStore((state) => state.projects);

  useEffect(() => {
    const selectedProject = selectedProjectId
      ? projects.find((project) => project.id === selectedProjectId)
      : null;
    document.title = selectedProject?.name.trim() || DEFAULT_TITLE;
  }, [pathname, projects, selectedProjectId]);

  return null;
}
