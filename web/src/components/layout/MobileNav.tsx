'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, type MouseEvent, type ReactNode } from 'react';
import { useTasksStore } from '@/features/tasks';
import { useProjectsStore } from '@/features/projects';
import { useDailyReportsStore } from '@/features/daily-reports';
import { computeProjectGroups } from '@/features/projects/utils/project-groups';
import { isProjectTaskGraphEnabled } from '@/features/projects/utils/task-graph-settings';
import { isTaskGraphReturnHref, normalizeTaskListReturnHref } from '@/features/tasks/utils/task-navigation';
import {
  AI_MANAGER_PATH_PREFIX,
  SETTINGS_ROOT_PATH,
  resolveSettingsHref,
  useSettingsNavStore,
} from '@/features/settings';

type NavIconProps = {
  active: boolean;
};

type NavItem = {
  href: string;
  activePaths: string[];
  label: string;
  Icon: (props: NavIconProps) => ReactNode;
  onDoubleClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
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

const GraphIcon = ({ active }: NavIconProps) => (
  <svg
    className={`w-6 h-6 transition-all duration-200 ${active ? 'scale-110' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <circle cx="6.5" cy="7" r="2.5" strokeWidth={active ? 2.4 : 2} />
    <circle cx="17.5" cy="7" r="2.5" strokeWidth={active ? 2.4 : 2} />
    <circle cx="12" cy="17" r="2.5" strokeWidth={active ? 2.4 : 2} />
    <path strokeLinecap="round" strokeWidth={active ? 2.4 : 2} d="M8.7 8.2l6.6 0M7.8 9.2l3.1 5.6M16.2 9.2l-3.1 5.6" />
  </svg>
);

const FlippingTasksIcon = ({ active, graph }: NavIconProps & { graph: boolean }) => (
  <span
    data-testid="mobile-tasks-icon"
    data-task-nav-icon={graph ? 'graph' : 'list'}
    className="relative inline-block h-6 w-6"
    style={{ perspective: '600px' }}
  >
    <span
      className="absolute inset-0 transition-transform duration-300 motion-reduce:transition-none"
      style={{
        transform: graph ? 'rotateY(180deg)' : 'rotateY(0deg)',
        transformStyle: 'preserve-3d',
      }}
    >
      <span className="absolute inset-0" style={{ backfaceVisibility: 'hidden' }}>
        <TasksIcon active={active} />
      </span>
      <span
        className="absolute inset-0"
        style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
      >
        <GraphIcon active={active} />
      </span>
    </span>
  </span>
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

const DailyIcon = ({ active }: NavIconProps) => (
  <svg
    className={`w-6 h-6 transition-all duration-200 ${active ? 'scale-110' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.4 : 2} d="M8 7h8M8 11h8M8 15h5M5 3h14a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 012-2z" />
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

const DAILY_REPORTS_PATH = '/app/daily-reports';

export function MobileNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { push } = useRouter();
  const unreadCount = useTasksStore((state) => state.unreadTaskIds.size);
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const dailyReportSetting = useDailyReportsStore((state) => state.setting);
  const isLoadingDailyReportSetting = useDailyReportsStore((state) => state.isLoadingSetting);
  const hydrateDailyReportSetting = useDailyReportsStore((state) => state.hydrateSetting);
  const projects = useProjectsStore((state) => state.projects);
  const lastSettingsPath = useSettingsNavStore((state) => state.lastPath);
  const urlProjectId = pathname.startsWith('/app/tasks') ? searchParams.get('projectId') : null;
  const taskProjectId = selectedProjectId ?? urlProjectId;
  const taskReturnHref = normalizeTaskListReturnHref(searchParams.get('from'));
  const taskGraphEnabled = useMemo(() => {
    if (!taskProjectId) return false;
    const groups = computeProjectGroups(projects);
    const group = groups.find((entry) =>
      entry.members.some((member) => member.id === taskProjectId),
    );
    const members = group?.members ?? projects.filter((project) => project.id === taskProjectId);
    return members.some((project) => isProjectTaskGraphEnabled(project));
  }, [projects, taskProjectId]);
  const isTaskDetailRoute = pathname.startsWith('/app/tasks/');
  const isTaskGraphView = pathname.startsWith('/app/tasks') && (
    searchParams.get('view') === 'graph' || (isTaskDetailRoute && isTaskGraphReturnHref(taskReturnHref))
  );
  const buildTasksHref = (includeGraphView: boolean) => {
    const params = new URLSearchParams();
    if (taskProjectId) {
      params.set('projectId', taskProjectId);
    }
    if (includeGraphView && taskGraphEnabled) {
      params.set('view', 'graph');
    }
    const query = params.toString();
    return query ? `/app/tasks?${query}` : '/app/tasks';
  };
  const tasksHref = isTaskDetailRoute && taskReturnHref ? taskReturnHref : buildTasksHref(isTaskGraphView);
  const issuesHref = selectedProjectId
    ? `/app/issues?projectId=${encodeURIComponent(selectedProjectId)}`
    : '/app/issues';
  const settingsHref = resolveSettingsHref(pathname, lastSettingsPath);
  const showDailyReports = Boolean(dailyReportSetting?.enabled);
  const handleTasksDoubleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!taskGraphEnabled) return;
    event.preventDefault();
    const params = pathname.startsWith('/app/tasks')
      ? new URLSearchParams(searchParams.toString())
      : new URLSearchParams();
    if (taskProjectId) {
      params.set('projectId', taskProjectId);
    }
    params.delete('from');
    params.delete('taskId');
    if (params.get('view') === 'graph') {
      params.delete('view');
    } else {
      params.set('view', 'graph');
    }
    const query = params.toString();
    push(query ? `/app/tasks?${query}` : '/app/tasks');
  };

  useEffect(() => {
    if (!dailyReportSetting && !isLoadingDailyReportSetting) {
      void hydrateDailyReportSetting();
    }
  }, [dailyReportSetting, hydrateDailyReportSetting, isLoadingDailyReportSetting]);

  const navItems: NavItem[] = [
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
      Icon: (props: NavIconProps) => <FlippingTasksIcon {...props} graph={isTaskGraphView} />,
      onDoubleClick: handleTasksDoubleClick,
    },
    ...(showDailyReports
      ? [{
        href: DAILY_REPORTS_PATH,
        activePaths: [DAILY_REPORTS_PATH],
        label: 'Daily',
        Icon: DailyIcon,
      }]
      : []),
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
            onDoubleClick={item.onDoubleClick}
            className={`relative flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-2 transition-colors ${
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
