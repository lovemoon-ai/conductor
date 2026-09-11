import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    task: { findMany: vi.fn(), count: vi.fn() },
    message: { findFirst: vi.fn() },
    project: { findMany: vi.fn() },
  },
}));

const { db } = await import("@/lib/db");
const { countAchievedTasks, searchAchievedTasks } = await import("./achieved-search");

const achievedRow = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  title: "Read the paper",
  projectId: "proj-home",
  secondProjectId: null,
  backendType: null,
  agentHost: null,
  executionHost: null,
  metadata: null,
  status: "completed",
  achievedAt: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
  project: { name: "Reading", daemonHost: "daemon-a" },
  _count: { messages: 3 },
  ...overrides,
});

describe("achieved task search", () => {
  beforeEach(() => {
    vi.mocked(db.task.findMany).mockReset();
    vi.mocked(db.task.count).mockReset();
    vi.mocked(db.project.findMany).mockReset();
  });

  it("filters by the project a task is displayed under, keeping the text search OR intact", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.task.count).mockResolvedValue(0 as any);

    await searchAchievedTasks({ userId: "user-1", query: "paper", projectIds: ["proj-work"] });
    await countAchievedTasks({ userId: "user-1", query: "paper", projectIds: ["proj-work"] });

    const expectedWhere = expect.objectContaining({
      project: { userId: "user-1" },
      AND: [
        { OR: [{ projectId: "proj-work", secondProjectId: null }, { secondProjectId: "proj-work" }] },
      ],
      OR: [
        { title: { contains: "paper" } },
        { messages: { some: { content: { contains: "paper" } } } },
      ],
    });
    expect(db.task.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
    expect(db.task.count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it("reports the filed project's id and name for a task filed elsewhere", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([
      achievedRow({ id: "task-home" }),
      achievedRow({ id: "task-filed", secondProjectId: "proj-work" }),
      // Filed under a project that has since been deleted: keep the real one.
      achievedRow({ id: "task-dangling", secondProjectId: "proj-gone" }),
    ] as any);
    vi.mocked(db.project.findMany).mockResolvedValue([{ id: "proj-work", name: "Work" }] as any);

    const results = await searchAchievedTasks({ userId: "user-1" });
    const byId = Object.fromEntries(results.map((result) => [result.id, result]));

    expect(byId["task-home"]).toMatchObject({ projectId: "proj-home", projectName: "Reading" });
    expect(byId["task-filed"]).toMatchObject({ projectId: "proj-work", projectName: "Work" });
    expect(byId["task-dangling"]).toMatchObject({ projectId: "proj-home", projectName: "Reading" });
    expect(db.project.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["proj-work", "proj-gone"] } },
      select: { id: true, name: true },
    });
  });
});
