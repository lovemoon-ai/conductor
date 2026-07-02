import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileNav } from './MobileNav';

let pathname = '/app/projects';
let unreadCount = 2;
let selectedProjectId: string | null = null;
let dailyReportEnabled = true;
let dailyReportLoading = false;
const hydrateDailyReportSettingMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

vi.mock('@/features/tasks', () => ({
  useTasksStore: (selector: (state: { unreadTaskIds: Set<string> }) => unknown) =>
    selector({ unreadTaskIds: new Set(Array.from({ length: unreadCount }, (_, index) => `task-${index}`)) }),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: { selectedProjectId: string | null }) => unknown) =>
    selector({ selectedProjectId }),
}));

vi.mock('@/features/daily-reports', () => ({
  useDailyReportsStore: (selector: (state: {
    setting: { enabled: boolean } | null;
    isLoadingSetting: boolean;
    hydrateSetting: () => Promise<null>;
  }) => unknown) =>
    selector({
      setting: { enabled: dailyReportEnabled },
      isLoadingSetting: dailyReportLoading,
      hydrateSetting: hydrateDailyReportSettingMock,
    }),
}));

describe('MobileNav', () => {
  beforeEach(() => {
    pathname = '/app/projects';
    unreadCount = 2;
    selectedProjectId = null;
    dailyReportEnabled = true;
    dailyReportLoading = false;
    hydrateDailyReportSettingMock.mockResolvedValue(null);
    hydrateDailyReportSettingMock.mockClear();
  });

  it('renders Daily as a top-level entry when enabled', () => {
    render(<MobileNav />);

    const links = screen.getAllByRole('link');

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/app/projects',
      '/app/issues',
      '/app/tasks',
      '/app/daily-reports',
      '/app/settings',
    ]);
  });

  it('links issues navigation to the selected project when present', () => {
    selectedProjectId = 'project-1';

    render(<MobileNav />);

    expect(screen.getByRole('link', { name: 'Issues' })).toHaveAttribute('href', '/app/issues?projectId=project-1');
  });

  it('links tasks navigation to the selected project when present', () => {
    selectedProjectId = 'project-1';

    render(<MobileNav />);

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/app/tasks?projectId=project-1');
  });

  it('keeps Daily active for daily reports without changing the Tasks link', () => {
    pathname = '/app/daily-reports';

    render(<MobileNav />);

    const dailyLink = screen.getByRole('link', { name: 'Daily' });
    const tasksLink = screen.getByRole('link', { name: 'Tasks' });
    expect(dailyLink).toHaveAttribute('href', '/app/daily-reports');
    expect(dailyLink.className).toContain('text-accent');
    expect(tasksLink).toHaveAttribute('href', '/app/tasks');
    expect(tasksLink.className).toContain('text-muted');
  });

  it('hides Daily when daily summaries are disabled', () => {
    dailyReportEnabled = false;

    render(<MobileNav />);

    expect(screen.queryByRole('link', { name: 'Daily' })).toBeNull();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/app/projects',
      '/app/issues',
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
