'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, type MouseEvent } from 'react';
import { useTasksStore } from '@/features/tasks';
import { useProjectsStore } from '@/features/projects';
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
  compact?: boolean;
};

const TasksIcon = ({ active, compact = false }: NavIconProps) => (
  <svg
    className={compact ? 'h-[18px] w-[18px]' : 'h-[18px] w-[18px]'}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.9} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  </svg>
);

const GraphIcon = ({ active, compact = false }: NavIconProps) => (
  <svg
    className={compact ? 'h-[18px] w-[18px]' : 'h-[18px] w-[18px]'}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <circle cx="6.5" cy="7" r="2.5" strokeWidth={active ? 2.2 : 1.9} />
    <circle cx="17.5" cy="7" r="2.5" strokeWidth={active ? 2.2 : 1.9} />
    <circle cx="12" cy="17" r="2.5" strokeWidth={active ? 2.2 : 1.9} />
    <path strokeLinecap="round" strokeWidth={active ? 2.2 : 1.9} d="M8.7 8.2l6.6 0M7.8 9.2l3.1 5.6M16.2 9.2l-3.1 5.6" />
  </svg>
);

const FlippingTasksIcon = ({
  active,
  compact = false,
  graph,
}: NavIconProps & { graph: boolean }) => (
  <span
    data-testid="sidebar-tasks-icon"
    data-task-nav-icon={graph ? 'graph' : 'list'}
    className="relative inline-block h-[18px] w-[18px]"
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
        <TasksIcon active={active} compact={compact} />
      </span>
      <span
        className="absolute inset-0"
        style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
      >
        <GraphIcon active={active} compact={compact} />
      </span>
    </span>
  </span>
);

const ProjectsIcon = ({ active, compact = false }: NavIconProps) => (
  <svg
    className={compact ? 'h-[18px] w-[18px]' : 'h-[18px] w-[18px]'}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.9} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

const IssuesIcon = ({ active, compact = false }: NavIconProps) => (
  <svg
    className={compact ? 'h-[18px] w-[18px]' : 'h-[18px] w-[18px]'}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.9} d="M9 12h6M9 16h4M9 8h6m-8 12h10a2 2 0 002-2V6a2 2 0 00-2-2H7a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const SettingsIcon = ({ active, compact = false }: NavIconProps) => (
  <svg
    className={compact ? 'h-[18px] w-[18px]' : 'h-[18px] w-[18px]'}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.9} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.9} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const CollapseIcon = () => (
  <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <rect x="4.5" y="5" width="15" height="14" rx="3" strokeWidth="1.9" />
    <path strokeLinecap="round" strokeWidth="1.9" d="M10 7.5v9" />
  </svg>
);

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

function SidebarTooltip({
  id,
  label,
  badge,
}: {
  id: string;
  label: string;
  badge?: number | null;
}) {
  return (
    <span
      id={id}
      role="tooltip"
      className="pointer-events-none absolute left-[calc(100%+0.75rem)] top-1/2 z-20 inline-flex -translate-y-1/2 items-center gap-2 rounded-xl border border-border bg-[var(--surface-panel)] px-3 py-2 text-xs font-medium text-ink shadow-[0_12px_32px_rgba(0,0,0,0.14)]"
    >
      <span>{label}</span>
      {badge ? (
        <span className="rounded-full bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[10px] font-semibold text-muted">
          {badge}
        </span>
      ) : null}
    </span>
  );
}

export function Sidebar({ collapsed = false, onToggleCollapsed }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { push } = useRouter();
  const unreadCount = useTasksStore((state) => state.unreadTaskIds.size);
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const projects = useProjectsStore((state) => state.projects);
  const lastSettingsPath = useSettingsNavStore((state) => state.lastPath);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const iconRailClassName = 'flex h-10 w-[52px] shrink-0 items-center justify-center';
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

  const navItems = [
    { href: '/app/projects', activePaths: ['/app/projects'], label: 'Projects', Icon: ProjectsIcon, badge: null },
    { href: issuesHref, activePaths: ['/app/issues'], label: 'Issues', Icon: IssuesIcon, badge: null },
    {
      href: tasksHref,
      activePaths: ['/app/tasks'],
      label: 'Tasks',
      Icon: (props: NavIconProps) => <FlippingTasksIcon {...props} graph={isTaskGraphView} />,
      badge: unreadCount > 0 ? unreadCount : null,
      onDoubleClick: handleTasksDoubleClick,
    },
    {
      href: settingsHref,
      activePaths: [SETTINGS_ROOT_PATH, AI_MANAGER_PATH_PREFIX],
      label: 'Settings',
      Icon: SettingsIcon,
      badge: null,
    },
  ];

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-border bg-[var(--surface-panel)] text-[var(--ink)] transition-[width] duration-200 motion-reduce:transition-none ${collapsed ? 'w-[68px]' : 'w-[272px]'}`}
      aria-label="Workspace sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="group/sidebar relative flex h-14 items-center px-2">
        <Link
          href="/app/tasks"
          className={`${iconRailClassName} rounded-xl transition-opacity ${
            collapsed
              ? 'cursor-ew-resize group-hover/sidebar:opacity-0'
              : ''
          }`}
          aria-label="Conductor home"
          title="Conductor home"
        >
          <Image
            src="/icon.svg"
            alt=""
            aria-hidden="true"
            width={32}
            height={32}
            className="size-8"
            priority
          />
        </Link>

        {collapsed ? (
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-controls="conductor-sidebar-primary-nav"
            aria-expanded={false}
            title="Expand sidebar"
            onClick={onToggleCollapsed}
            className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 cursor-ew-resize rounded-2xl bg-transparent text-[var(--ink)] opacity-0 transition-opacity group-hover/sidebar:pointer-events-auto group-hover/sidebar:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35 ${iconRailClassName}`}
          >
            <CollapseIcon />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-controls="conductor-sidebar-primary-nav"
            aria-expanded={true}
            title="Collapse sidebar"
            onClick={onToggleCollapsed}
            className="absolute right-2 top-1/2 inline-flex size-10 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-2xl bg-transparent text-[var(--ink)] transition-colors hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35"
          >
            <CollapseIcon />
          </button>
        )}
      </div>

      <nav
        id="conductor-sidebar-primary-nav"
        aria-label="Primary navigation"
        className="flex-1 overflow-y-auto px-2 pb-4 webapp-scrollbar"
      >
        <div className="space-y-0.5">
          {navItems.map((item) => {
            const isActive = item.activePaths.some((path) => pathname.startsWith(path));
            const tooltipId = `sidebar-tooltip-${item.label.toLowerCase()}`;
            const isTooltipVisible = collapsed && activeTooltip === item.label;

            return (
              <Link
                key={item.label}
                href={item.href}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                aria-describedby={isTooltipVisible ? tooltipId : undefined}
                title={collapsed ? item.label : undefined}
                onDoubleClick={item.onDoubleClick}
                onMouseEnter={() => {
                  if (collapsed) {
                    setActiveTooltip(item.label);
                  }
                }}
                onMouseLeave={() => {
                  if (collapsed) {
                    setActiveTooltip((current) => (current === item.label ? null : current));
                  }
                }}
                onFocus={() => {
                  if (collapsed) {
                    setActiveTooltip(item.label);
                  }
                }}
                onBlur={() => {
                  if (collapsed) {
                    setActiveTooltip((current) => (current === item.label ? null : current));
                  }
                }}
                className={`relative flex h-10 items-center rounded-xl text-[15px] transition-colors ${
                  isActive
                    ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
                    : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
                } ${collapsed ? 'justify-center' : 'pr-3'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35`}
              >
                <span className={iconRailClassName}>
                  <item.Icon active={isActive} compact={collapsed} />
                </span>
                {!collapsed ? (
                  <>
                    <span className={`min-w-0 flex-1 truncate leading-none ${isActive ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
                    {item.badge ? (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] leading-none font-semibold ${
                        isActive
                          ? 'bg-[var(--surface-default)] text-[var(--ink)]'
                          : 'bg-[var(--surface-default)] text-zinc-500 dark:text-zinc-300'
                      }`}
                      >
                        {item.badge}
                      </span>
                    ) : null}
                  </>
                ) : item.badge ? (
                  <span className="absolute right-2 top-2 size-2 rounded-full bg-[var(--error)]" />
                ) : null}
                {isTooltipVisible ? (
                  <SidebarTooltip id={tooltipId} label={item.label} badge={item.badge} />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
