import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Project } from '@/shared/types';
import { ProjectDocumentTitle } from './ProjectDocumentTitle';

let pathname = '/app/tasks';
let searchString = '';
let selectedProjectId: string | null = null;
let projects: Project[] = [];

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(searchString),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (
    selector: (state: { selectedProjectId: string | null; projects: Project[] }) => unknown,
  ) => selector({ selectedProjectId, projects }),
}));

const makeProject = (id: string, name: string): Project => ({ id, name });

describe('ProjectDocumentTitle', () => {
  beforeEach(() => {
    pathname = '/app/tasks';
    searchString = '';
    selectedProjectId = null;
    projects = [];
    document.title = 'initial';
  });

  it('falls back to "Conductor" when no project is selected and no URL hint', () => {
    projects = [makeProject('p1', 'Alpha')];

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Conductor');
  });

  it('shows the sidebar-selected project name', () => {
    projects = [makeProject('p1', 'Alpha'), makeProject('p2', 'Beta')];
    selectedProjectId = 'p2';

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Beta');
  });

  it('falls back to "Conductor" when the selected project is not loaded yet', () => {
    projects = [];
    selectedProjectId = 'p-not-loaded';

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Conductor');
  });

  it('trims the project name and falls back when it is blank', () => {
    projects = [makeProject('p1', '  Padded  '), makeProject('p2', '   ')];

    selectedProjectId = 'p1';
    const { rerender } = render(<ProjectDocumentTitle />);
    expect(document.title).toBe('Padded');

    selectedProjectId = 'p2';
    rerender(<ProjectDocumentTitle />);
    expect(document.title).toBe('Conductor');
  });

  it('keeps the project title across in-app routes (projects/issues/tasks/settings)', () => {
    projects = [makeProject('p1', 'Alpha')];
    selectedProjectId = 'p1';

    const { rerender } = render(<ProjectDocumentTitle />);
    expect(document.title).toBe('Alpha');

    for (const route of [
      '/app/projects',
      '/app/issues',
      '/app/tasks',
      '/app/tasks/t1',
      '/app/settings',
    ]) {
      pathname = route;
      rerender(<ProjectDocumentTitle />);
      expect(document.title).toBe('Alpha');
    }
  });

  it('updates the title when the selected project changes', () => {
    projects = [makeProject('p1', 'Alpha'), makeProject('p2', 'Beta')];
    selectedProjectId = 'p1';

    const { rerender } = render(<ProjectDocumentTitle />);
    expect(document.title).toBe('Alpha');

    selectedProjectId = 'p2';
    rerender(<ProjectDocumentTitle />);
    expect(document.title).toBe('Beta');
  });

  it('uses the URL `projectId` as a fallback when the store has no selection yet', () => {
    pathname = '/app/tasks';
    searchString = 'projectId=p1&taskId=t1';
    projects = [makeProject('p1', 'Default project')];
    selectedProjectId = null; // store not yet synced from the URL

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Default project');
  });

  it('prefers the URL `projectId` over the store selection when both resolve', () => {
    // The page (e.g. /app/tasks) is authoritative — the URL is what the user
    // navigated to. The store can lag (it's synced from the URL in a
    // useEffect) so URL should win to avoid a stale-store flash.
    pathname = '/app/tasks';
    searchString = 'projectId=p-url';
    projects = [makeProject('p-url', 'URL Project'), makeProject('p-store', 'Store Project')];
    selectedProjectId = 'p-store';

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('URL Project');
  });

  it('falls back to the store selection when the URL `projectId` is not in the loaded projects', () => {
    pathname = '/app/tasks';
    searchString = 'projectId=p-stale-link';
    projects = [makeProject('p-store', 'Store Project')];
    selectedProjectId = 'p-store';

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Store Project');
  });

  it('does not let a stale `selectedProjectId` (truthy but unknown) mask a valid URL `projectId`', () => {
    // Regression: previously `selectedProjectId || urlProjectId` short-
    // circuited when the store held a leftover id from a deleted project,
    // so the title fell straight to "Conductor" even though the URL pointed
    // at a real project. Each candidate must be resolved independently.
    pathname = '/app/tasks';
    searchString = 'projectId=92d3c4e8-2dfc-4b18-a592-dff58ec8efb4';
    projects = [makeProject('92d3c4e8-2dfc-4b18-a592-dff58ec8efb4', 'Default project')];
    selectedProjectId = 'p-deleted-stale'; // not in `projects`

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Default project');
  });

  it('re-applies the project title on every render so an external "Conductor" reset is overwritten', () => {
    // Regression: on the tasks page the in-app shell re-renders frequently
    // (tasks polling, websocket events, search-param replacements, …) and
    // each commit reconciles the root layout's `<title>Conductor</title>`
    // metadata element, writing `document.title = "Conductor"` again. The
    // component must re-apply on every render — not just when its inputs
    // change — so the title doesn't get stuck on "Conductor".
    projects = [makeProject('p1', 'Alpha')];
    selectedProjectId = 'p1';

    const { rerender } = render(<ProjectDocumentTitle />);
    expect(document.title).toBe('Alpha');

    // Simulate Next.js metadata reconciliation clobbering the title between
    // renders without any of the component's tracked inputs changing.
    document.title = 'Conductor';

    rerender(<ProjectDocumentTitle />);

    expect(document.title).toBe('Alpha');
  });

  it('falls back to "Conductor" when neither the URL nor the store resolves a project', () => {
    pathname = '/app/tasks';
    searchString = 'projectId=p-missing';
    projects = [makeProject('p1', 'Alpha')];
    selectedProjectId = null;

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Conductor');
  });
});
