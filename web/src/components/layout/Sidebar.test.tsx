import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from './Sidebar';

let pathname = '/app/tasks';
let unreadCount = 3;
let selectedProjectId: string | null = null;

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

vi.mock('next/image', () => ({
  default: ({ priority: _priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => (
    <img {...props} alt={props.alt ?? ''} />
  ),
}));

vi.mock('@/features/tasks', () => ({
  useTasksStore: (selector: (state: { unreadTaskIds: Set<string> }) => unknown) =>
    selector({ unreadTaskIds: new Set(Array.from({ length: unreadCount }, (_, index) => `task-${index}`)) }),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: { selectedProjectId: string | null }) => unknown) =>
    selector({ selectedProjectId }),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    pathname = '/app/tasks';
    unreadCount = 3;
    selectedProjectId = null;
  });

  it('renders primary navigation with unread badge', () => {
    render(<Sidebar />);

    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    const links = within(navigation).getAllByRole('link').filter((link) => {
      const href = link.getAttribute('href');
      return href === '/app/projects' || href === '/app/issues' || href === '/app/tasks' || href === '/app/settings';
    });

    expect(navigation).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Projects/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Issues/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Docs/i })).toBeNull();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/app/projects',
      '/app/issues',
      '/app/tasks',
      '/app/settings',
    ]);
  });

  it('links issues navigation to the selected project when present', () => {
    selectedProjectId = 'project-1';

    render(<Sidebar />);

    expect(screen.getByRole('link', { name: /Issues/i })).toHaveAttribute('href', '/app/issues?projectId=project-1');
  });

  it('links tasks navigation to the selected project when present', () => {
    selectedProjectId = 'project-1';

    render(<Sidebar />);

    expect(screen.getByRole('link', { name: /Tasks/i })).toHaveAttribute('href', '/app/tasks?projectId=project-1');
  });

  it('highlights the active route and exposes aria-current', () => {
    pathname = '/app/settings';
    render(<Sidebar />);

    const settingsLink = screen.getByRole('link', { name: /Settings/i });
    expect(settingsLink.className).toContain('text-[var(--ink)]');
    expect(settingsLink).toHaveAttribute('aria-current', 'page');
  });

  it('renders collapsed mode with expand button and icon-only navigation', () => {
    const onToggleCollapsed = vi.fn();
    render(<Sidebar collapsed onToggleCollapsed={onToggleCollapsed} />);

    const expandButton = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expandButton).toBeInTheDocument();
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Tasks')).toBeNull();

    fireEvent.click(expandButton);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('shows a tooltip for collapsed nav items on hover and focus', () => {
    render(<Sidebar collapsed />);

    const projectsLink = screen.getByRole('link', { name: 'Projects' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(projectsLink);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Projects');
    expect(projectsLink).toHaveAttribute('aria-describedby', 'sidebar-tooltip-projects');

    fireEvent.mouseLeave(projectsLink);
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.focus(projectsLink);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Projects');

    fireEvent.blur(projectsLink);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
