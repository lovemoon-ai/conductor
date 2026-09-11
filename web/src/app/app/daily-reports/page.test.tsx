import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DailyReport } from '@/features/daily-reports';
import DailyReportsPage from './page';

const replaceMock = vi.fn();
const hydrateSettingMock = vi.fn();
const fetchReportMock = vi.fn();
const generateReportMock = vi.fn();
const fetchHistoryMock = vi.fn();
const searchParamsState = new URLSearchParams('date=2026-07-01');
let hiddenProjectIdsState: string[] = [];
let projectsState: Array<{ id: string }> = [];
let reportState: DailyReport;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => searchParamsState,
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('@/features/chat/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/features/daily-reports', () => ({
  useDailyReportsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    setting: { timezone: 'Asia/Shanghai' },
    currentReport: reportState,
    history: [],
    isLoadingReport: false,
    isGenerating: false,
    error: null,
    hydrateSetting: hydrateSettingMock,
    fetchReport: fetchReportMock,
    generateReport: generateReportMock,
    fetchHistory: fetchHistoryMock,
  }),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: {
    hiddenProjectIds: string[];
    projects: Array<{ id: string }>;
    error: string | null;
  }) => unknown) =>
    selector({ hiddenProjectIds: hiddenProjectIdsState, projects: projectsState, error: null }),
}));

const makeProject = (projectId: string, projectName: string, tasksTouched: number) => ({
  projectId,
  projectName,
  daemonHost: null,
  summary: `${tasksTouched} tasks touched`,
  stats: { tasksTouched, messages: tasksTouched * 2, completed: tasksTouched, running: 0, killed: 0 },
  timeline: [],
});

const makeReport = (): DailyReport => ({
  id: 'report-1',
  reportDate: '2026-07-01',
  timezone: 'Asia/Shanghai',
  status: 'generated',
  summaryMarkdown: '',
  payload: {
    totals: { projects: 2, tasks: 5, messages: 10, completed: 5, running: 0, killed: 0 },
    projects: [
      makeProject('project-visible', 'Visible Project', 2),
      makeProject('project-archived', 'Archived Project', 3),
    ],
    summarizer: null,
  },
  deliveryChannels: ['in_app'],
  sentAt: null,
  lastError: null,
  persisted: true,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
});

const totalValue = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('DailyReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hiddenProjectIdsState = [];
    projectsState = [{ id: 'project-visible' }, { id: 'project-archived' }];
    reportState = makeReport();
  });

  it('shows every project in a saved report when none are hidden', () => {
    render(<DailyReportsPage />);

    expect(screen.getByText('Visible Project')).toBeInTheDocument();
    expect(screen.getByText('Archived Project')).toBeInTheDocument();
    expect(totalValue('Projects')).toBe('2');
    expect(totalValue('Tasks')).toBe('5');
  });

  it('hides archived (hidden) projects from a saved report and recomputes the totals', () => {
    hiddenProjectIdsState = ['project-archived'];

    render(<DailyReportsPage />);

    expect(screen.getByText('Visible Project')).toBeInTheDocument();
    expect(screen.queryByText('Archived Project')).not.toBeInTheDocument();
    expect(totalValue('Projects')).toBe('1');
    expect(totalValue('Tasks')).toBe('2');
  });

  it('waits for projects to load before rendering a saved report', () => {
    projectsState = [];

    render(<DailyReportsPage />);

    expect(screen.queryByText('Visible Project')).not.toBeInTheDocument();
    expect(screen.queryByText('Archived Project')).not.toBeInTheDocument();
    expect(screen.queryByText(/No task activity recorded/)).not.toBeInTheDocument();
  });
});
