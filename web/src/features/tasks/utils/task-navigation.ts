const TASK_LIST_PATH = '/app/tasks';
const TASK_DETAIL_PATH_PREFIX = '/app/tasks/';
const INTERNAL_URL_ORIGIN = 'https://conductor.local';

export const normalizeTaskListReturnHref = (href?: string | null): string | null => {
  if (!href) return null;

  try {
    const url = new URL(href, INTERNAL_URL_ORIGIN);
    if (url.origin !== INTERNAL_URL_ORIGIN) return null;
    if (url.pathname !== TASK_LIST_PATH) return null;

    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
};

export const isTaskGraphReturnHref = (href?: string | null): boolean => {
  const normalized = normalizeTaskListReturnHref(href);
  if (!normalized) return false;

  const queryIndex = normalized.indexOf('?');
  if (queryIndex < 0) return false;
  return new URLSearchParams(normalized.slice(queryIndex + 1)).get('view') === 'graph';
};

export const buildTaskDetailHref = (taskId: string, returnHref?: string | null): string => {
  const normalizedReturnHref = normalizeTaskListReturnHref(returnHref);
  const params = new URLSearchParams();
  if (normalizedReturnHref) {
    params.set('from', normalizedReturnHref);
  }

  const query = params.toString();
  return `${TASK_DETAIL_PATH_PREFIX}${encodeURIComponent(taskId)}${query ? `?${query}` : ''}`;
};
