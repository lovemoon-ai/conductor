import { describe, expect, it } from "vitest";
import type { DailyReport, DailyReportProject } from "./store";
import { excludeArchivedReportProjects } from "./visible-projects";

const makeProject = (projectId: string, stats: DailyReportProject["stats"]): DailyReportProject => ({
  projectId,
  projectName: projectId,
  daemonHost: null,
  summary: "",
  stats,
  timeline: [],
});

const makePayload = (projects: DailyReportProject[]): DailyReport["payload"] => ({
  totals: { projects: 2, tasks: 5, messages: 12, completed: 3, running: 1, killed: 1 },
  projects,
  summarizer: null,
});

describe("excludeArchivedReportProjects", () => {
  const visible = makeProject("project-visible", { tasksTouched: 2, messages: 5, completed: 1, running: 1, killed: 0 });
  const archived = makeProject("project-archived", { tasksTouched: 3, messages: 7, completed: 2, running: 0, killed: 1 });

  it("returns the payload unchanged when no reported project is hidden", () => {
    const payload = makePayload([visible, archived]);
    const result = excludeArchivedReportProjects(payload, ["project-elsewhere"]);
    expect(result.projects).toBe(payload.projects);
    expect(result.totals).toBe(payload.totals);
  });

  it("drops hidden projects and recomputes totals from the remaining ones", () => {
    const result = excludeArchivedReportProjects(makePayload([visible, archived]), ["project-archived"]);
    expect(result.projects.map((project) => project.projectId)).toEqual(["project-visible"]);
    expect(result.totals).toEqual({ projects: 1, tasks: 2, messages: 5, completed: 1, running: 1, killed: 0 });
  });
});
