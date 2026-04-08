import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileNav } from './MobileNav';

let pathname = '/app/projects';
let unreadCount = 2;

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

vi.mock('@/lib/conductor/stores/tasks', () => ({
  useTasksStore: (selector: (state: { unreadTaskIds: Set<string> }) => unknown) =>
    selector({ unreadTaskIds: new Set(Array.from({ length: unreadCount }, (_, index) => `task-${index}`)) }),
}));

describe('MobileNav', () => {
  it('renders projects before tasks', () => {
    render(<MobileNav />);

    const links = screen.getAllByRole('link');

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/app/projects',
      '/app/tasks',
      '/app/settings',
    ]);
  });

  it('shows the unread indicator on tasks while keeping the active route on projects', () => {
    render(<MobileNav />);

    const projectsLink = screen.getByRole('link', { name: 'Projects' });
    const tasksLink = screen.getByRole('link', { name: 'Tasks' });

    expect(projectsLink.className).toContain('text-accent');
    expect(tasksLink.className).toContain('text-muted');
    expect(tasksLink.querySelector('.bg-error')).not.toBeNull();
  });
});
