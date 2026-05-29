'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTasksStore } from '@/features/tasks';
import { useProjectsStore } from '@/features/projects';
import {
  AI_MANAGER_PATH_PREFIX,
  SETTINGS_ROOT_PATH,
  resolveSettingsHref,
  useSettingsNavStore,
} from '@/features/settings';

type NavIconProps = {
  active: boolean;
};

const TasksIcon = ({ active }: NavIconProps) => (
  <svg
    className={`w-6 h-6 transition-all duration-200 ${active ? 'scale-110' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.4 : 2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  </svg>
);

const ProjectsIcon = ({ active }: NavIconProps) => (
  <svg
    className={`w-6 h-6 transition-all duration-200 ${active ? 'scale-110' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.4 : 2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

const IssuesIcon = ({ active }: NavIconProps) => (
  <svg
    className={`w-6 h-6 transition-all duration-200 ${active ? 'scale-110' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.4 : 2} d="M9 12h6M9 16h4M9 8h6m-8 12h10a2 2 0 002-2V6a2 2 0 00-2-2H7a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const SettingsIcon = ({ active }: NavIconProps) => (
  <svg
    className={`w-6 h-6 transition-all duration-200 ${active ? 'scale-110 rotate-12' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.4 : 2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.4 : 2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export function MobileNav() {
  const pathname = usePathname();
  const unreadCount = useTasksStore((state) => state.unreadTaskIds.size);
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const lastSettingsPath = useSettingsNavStore((state) => state.lastPath);
  const tasksHref = selectedProjectId
    ? `/app/tasks?projectId=${encodeURIComponent(selectedProjectId)}`
    : '/app/tasks';
  const issuesHref = selectedProjectId
    ? `/app/issues?projectId=${encodeURIComponent(selectedProjectId)}`
    : '/app/issues';
  const settingsHref = resolveSettingsHref(pathname, lastSettingsPath);

  const navItems = [
    {
      href: '/app/projects',
      activePaths: ['/app/projects'],
      label: 'Projects',
      Icon: ProjectsIcon,
    },
    {
      href: issuesHref,
      activePaths: ['/app/issues'],
      label: 'Issues',
      Icon: IssuesIcon,
    },
    {
      href: tasksHref,
      activePaths: ['/app/tasks'],
      label: 'Tasks',
      Icon: TasksIcon,
    },
    {
      href: settingsHref,
      activePaths: [SETTINGS_ROOT_PATH, AI_MANAGER_PATH_PREFIX],
      label: 'Settings',
      Icon: SettingsIcon,
    },
  ];

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 h-16 bg-panel/95 backdrop-blur border-t border-border flex items-center justify-around md:hidden safe-area-bottom">
      {navItems.map((item) => {
        const isActive = item.activePaths.some((path) => pathname.startsWith(path));
        const showTasksBadge = item.activePaths.includes('/app/tasks');
        return (
          <Link
            key={item.label}
            href={item.href}
            className={`flex flex-col items-center gap-0.5 px-6 py-2 relative transition-colors ${
              isActive ? 'text-accent' : 'text-muted'
            }`}
          >
            <div className="relative">
              <item.Icon active={isActive} />
              {showTasksBadge && unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 size-2.5 bg-error rounded-full border-2 border-panel" />
              )}
            </div>
            <span className={`text-xs ${isActive ? 'font-medium' : ''}`}>{item.label}</span>
            {isActive && (
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 size-1 rounded-full webapp-gradient-bg" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
