import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Project } from '@/shared/types';
import { ProjectDocumentTitle } from './ProjectDocumentTitle';

let pathname = '/app/tasks';
let selectedProjectId: string | null = null;
let projects: Project[] = [];

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
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
    selectedProjectId = null;
    projects = [];
    document.title = 'initial';
  });

  it('falls back to "Conductor" when no project is selected', () => {
    projects = [makeProject('p1', 'Alpha')];
    selectedProjectId = null;

    render(<ProjectDocumentTitle />);

    expect(document.title).toBe('Conductor');
  });

  it('shows the selected project name', () => {
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

  it('updates the title when the selected project changes', () => {
    projects = [makeProject('p1', 'Alpha'), makeProject('p2', 'Beta')];
    selectedProjectId = 'p1';

    const { rerender } = render(<ProjectDocumentTitle />);
    expect(document.title).toBe('Alpha');

    selectedProjectId = 'p2';
    rerender(<ProjectDocumentTitle />);
    expect(document.title).toBe('Beta');
  });
});
