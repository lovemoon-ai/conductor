export const ISSUE_STATUSES = [
  'backlog',
  'todo',
  'doing',
  'review',
  'done',
] as const;

export type IssueStatusValue = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatusValue, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
};

export const ISSUE_STATUS_BADGE_CLASSNAMES: Record<IssueStatusValue, string> = {
  backlog: 'border-transparent bg-indigo-100/90 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-100',
  todo: 'border-sky-400/80 bg-sky-200/85 text-sky-800 dark:border-sky-700 dark:bg-sky-950/70 dark:text-sky-100',
  doing: 'border-amber-400/80 bg-amber-200/85 text-amber-800 dark:border-amber-700 dark:bg-amber-950/70 dark:text-amber-100',
  review: 'border-violet-400/80 bg-violet-200/85 text-violet-800 dark:border-violet-700 dark:bg-violet-950/70 dark:text-violet-100',
  done: 'border-emerald-400/80 bg-emerald-200/85 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-100',
};

export const ISSUE_STATUS_TITLE_CLASSNAMES: Record<IssueStatusValue, string> = {
  backlog: 'border-transparent bg-indigo-100/90 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-100',
  todo: 'border-transparent bg-sky-100/90 text-sky-800 dark:bg-sky-950/70 dark:text-sky-100',
  doing: 'border-transparent bg-amber-100/90 text-amber-800 dark:bg-amber-950/70 dark:text-amber-100',
  review: 'border-transparent bg-violet-100/90 text-violet-800 dark:bg-violet-950/70 dark:text-violet-100',
  done: 'border-transparent bg-emerald-100/90 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-100',
};

export const ISSUE_STATUS_COLUMN_CLASSNAMES: Record<IssueStatusValue, string> = {
  backlog: 'border-border bg-transparent',
  todo: 'border-border bg-transparent',
  doing: 'border-border bg-transparent',
  review: 'border-border bg-transparent',
  done: 'border-border bg-transparent',
};

export const ISSUE_STATUS_FILTER_CLASSNAMES: Record<IssueStatusValue, string> = {
  backlog: 'border-transparent bg-indigo-100/90 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-100',
  todo: 'border-transparent bg-sky-100/90 text-sky-800 dark:bg-sky-950/70 dark:text-sky-100',
  doing: 'border-transparent bg-amber-100/90 text-amber-800 dark:bg-amber-950/70 dark:text-amber-100',
  review: 'border-transparent bg-violet-100/90 text-violet-800 dark:bg-violet-950/70 dark:text-violet-100',
  done: 'border-transparent bg-emerald-100/90 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-100',
};

export const ACTIVE_ISSUE_TASK_STATUSES = ['init', 'running', 'unknown'] as const;

export const normalizeIssueStatus = (value: unknown): IssueStatusValue => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (ISSUE_STATUSES.includes(normalized as IssueStatusValue)) {
    return normalized as IssueStatusValue;
  }
  return 'backlog';
};

export const isIssueStatus = (value: unknown): value is IssueStatusValue => {
  return typeof value === 'string' && ISSUE_STATUSES.includes(value.trim().toLowerCase() as IssueStatusValue);
};
