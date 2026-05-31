'use client';

import { useLayoutEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useProjectsStore } from '@/features/projects';

const DEFAULT_TITLE = 'Conductor';

/**
 * Keeps the browser tab title in sync with the current project context across
 * every in-app page (projects, issues, tasks list, task chat, settings, …).
 *
 * Resolution order for the project name:
 *   1. The URL's `?projectId=` query param. The sidebar navigates to
 *      `/app/tasks?projectId=…` and `/app/issues?projectId=…` with that
 *      param, and pages only sync it into the store inside a `useEffect`,
 *      so the URL is the most authoritative source on first paint.
 *   2. The store's `selectedProjectId` (sidebar selection). Used on pages
 *      that don't put a `projectId` in the URL (projects, settings) and as
 *      a fallback if the URL `projectId` can't be resolved (e.g. stale
 *      link to a deleted project).
 *   3. Falls back to "Conductor" when nothing resolves.
 *
 * Each candidate is resolved against the loaded `projects` list
 * independently — a truthy-but-unresolvable id (stale localStorage, deleted
 * project) does not short-circuit and mask the next valid candidate.
 *
 * Implementation notes:
 *   - Uses `useLayoutEffect` and **intentionally re-runs on every render**
 *     (no dependency array). Routes like `/app/tasks` re-render the in-app
 *     shell very frequently (tasks polling, websocket events, search-param
 *     replacements, …). On every commit, React reconciles the root
 *     layout's metadata `<title>Conductor</title>` element into the head,
 *     which writes `document.title = "Conductor"` again. A dep-gated
 *     `useEffect` won't fire if its inputs are unchanged, so the title
 *     gets stuck on "Conductor". Re-applying every commit, synchronously
 *     before the browser paints, keeps the project name visible.
 *
 * Renders nothing.
 */
export function ProjectDocumentTitle() {
  // Subscribe to pathname / searchParams so client-side navigation re-renders
  // this component (and re-runs the layout effect below) on URL changes.
  // The values themselves are read inside the effect.
  usePathname();
  const searchParams = useSearchParams();
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const projects = useProjectsStore((state) => state.projects);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- see "Implementation notes" in the JSDoc above.
  useLayoutEffect(() => {
    const urlProjectId = searchParams?.get('projectId') ?? null;
    const projectFromUrl = urlProjectId
      ? projects.find((candidate) => candidate.id === urlProjectId)
      : null;
    const projectFromStore = selectedProjectId
      ? projects.find((candidate) => candidate.id === selectedProjectId)
      : null;
    const project = projectFromUrl ?? projectFromStore;
    document.title = project?.name.trim() || DEFAULT_TITLE;
  });

  return null;
}
