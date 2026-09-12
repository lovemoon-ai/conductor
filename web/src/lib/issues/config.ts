export const ISSUE_STATUSES = [
  'todo',
  'doing',
  'done',
] as const;

export type IssueStatusValue = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = [
  'P0',
  'P1',
  'P2',
] as const;

export type IssuePriorityValue = (typeof ISSUE_PRIORITIES)[number];

export const DEFAULT_ISSUE_PRIORITY: IssuePriorityValue = 'P1';

export const ISSUE_TYPES = [
  'feature',
  'bug',
  'research',
] as const;

export type IssueTypeValue = (typeof ISSUE_TYPES)[number];

export const DEFAULT_ISSUE_TYPE: IssueTypeValue = 'feature';

export const ISSUE_STATUS_LABELS: Record<IssueStatusValue, string> = {
  todo: 'Todo',
  doing: 'Doing',
  done: 'Done',
};

export const ISSUE_STATUS_BADGE_CLASSNAMES: Record<IssueStatusValue, string> = {
  todo: 'border-sky-400/80 bg-sky-200/85 text-sky-800 dark:border-sky-700 dark:bg-sky-950/70 dark:text-sky-100',
  doing: 'border-amber-400/80 bg-amber-200/85 text-amber-800 dark:border-amber-700 dark:bg-amber-950/70 dark:text-amber-100',
  done: 'border-emerald-400/80 bg-emerald-200/85 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-100',
};

export const ISSUE_STATUS_TITLE_CLASSNAMES: Record<IssueStatusValue, string> = {
  todo: 'border-transparent bg-sky-100/90 text-sky-800 dark:bg-sky-950/70 dark:text-sky-100',
  doing: 'border-transparent bg-amber-100/90 text-amber-800 dark:bg-amber-950/70 dark:text-amber-100',
  done: 'border-transparent bg-emerald-100/90 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-100',
};

export const ISSUE_STATUS_COLUMN_CLASSNAMES: Record<IssueStatusValue, string> = {
  todo: 'border-border bg-transparent',
  doing: 'border-border bg-transparent',
  done: 'border-border bg-transparent',
};

export const ISSUE_STATUS_FILTER_CLASSNAMES: Record<IssueStatusValue, string> = {
  todo: 'border-transparent bg-sky-100/90 text-sky-800 dark:bg-sky-950/70 dark:text-sky-100',
  doing: 'border-transparent bg-amber-100/90 text-amber-800 dark:bg-amber-950/70 dark:text-amber-100',
  done: 'border-transparent bg-emerald-100/90 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-100',
};

export const ACTIVE_ISSUE_TASK_STATUSES = ['init', 'running', 'killing', 'unknown'] as const;

const LEGACY_ISSUE_STATUS_ALIASES: Record<string, IssueStatusValue> = {
  backlog: 'todo',
  review: 'doing',
};

export const coerceIssueStatus = (value: unknown): IssueStatusValue | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (ISSUE_STATUSES.includes(normalized as IssueStatusValue)) {
    return normalized as IssueStatusValue;
  }
  return LEGACY_ISSUE_STATUS_ALIASES[normalized] ?? null;
};

export const normalizeIssueStatus = (value: unknown): IssueStatusValue => {
  return coerceIssueStatus(value) ?? 'todo';
};

const isIssueStatus = (value: unknown): value is IssueStatusValue => {
  return typeof value === 'string' && ISSUE_STATUSES.includes(value.trim().toLowerCase() as IssueStatusValue);
};

export const ISSUE_PRIORITY_LABELS: Record<IssuePriorityValue, string> = {
  P0: 'P0 (Highest)',
  P1: 'P1',
  P2: 'P2 (Lowest)',
};

export const coerceIssuePriority = (value: unknown): IssuePriorityValue | null => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (ISSUE_PRIORITIES.includes(normalized as IssuePriorityValue)) {
    return normalized as IssuePriorityValue;
  }
  return null;
};

export const normalizeIssuePriority = (value: unknown): IssuePriorityValue => {
  return coerceIssuePriority(value) ?? DEFAULT_ISSUE_PRIORITY;
};

export const ISSUE_TYPE_LABELS: Record<IssueTypeValue, string> = {
  feature: 'Feature',
  bug: 'Bug',
  research: 'Research',
};

export const ISSUE_TYPE_BADGE_CLASSNAMES: Record<IssueTypeValue, string> = {
  feature: 'border-violet-400/80 bg-violet-200/85 text-violet-800 dark:border-violet-700 dark:bg-violet-950/70 dark:text-violet-100',
  bug: 'border-rose-400/80 bg-rose-200/85 text-rose-800 dark:border-rose-700 dark:bg-rose-950/70 dark:text-rose-100',
  research: 'border-teal-400/80 bg-teal-200/85 text-teal-800 dark:border-teal-700 dark:bg-teal-950/70 dark:text-teal-100',
};

export const coerceIssueType = (value: unknown): IssueTypeValue | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (ISSUE_TYPES.includes(normalized as IssueTypeValue)) {
    return normalized as IssueTypeValue;
  }
  return null;
};

export const normalizeIssueType = (value: unknown): IssueTypeValue => {
  return coerceIssueType(value) ?? DEFAULT_ISSUE_TYPE;
};
