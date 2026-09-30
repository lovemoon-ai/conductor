type ReportTotals = {
  projects: number;
  tasks: number;
  messages: number;
  completed: number;
  running: number;
  killed: number;
};

type ReportProject = {
  projectId: string;
  stats: { tasksTouched: number; messages: number; completed: number; running: number; killed: number };
};

/**
 * Drops archived (hidden) projects from a report so saved reports follow the
 * Project List hide state, and recomputes the totals from what remains.
 */
export const excludeArchivedReportProjects = <P extends ReportProject, T extends ReportTotals>(
  payload: { projects: P[]; totals: T },
  hiddenProjectIds: Iterable<string>,
): { projects: P[]; totals: T } => {
  const hiddenProjectIdSet = new Set(hiddenProjectIds);
  const projects = payload.projects.filter((project) => !hiddenProjectIdSet.has(project.projectId));
  if (projects.length === payload.projects.length) {
    return { projects: payload.projects, totals: payload.totals };
  }

  const totals = { ...payload.totals, projects: projects.length, tasks: 0, messages: 0, completed: 0, running: 0, killed: 0 };
  for (const project of projects) {
    totals.tasks += project.stats.tasksTouched;
    totals.messages += project.stats.messages;
    totals.completed += project.stats.completed;
    totals.running += project.stats.running;
    totals.killed += project.stats.killed;
  }
  return { projects, totals };
};
