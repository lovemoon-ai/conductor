import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";
import { GET } from "./route";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    project: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/projects/daemon-binding", () => ({
  resolveProjectAgentsRegistry: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { resolveProjectAgentsRegistry } = await import("@/lib/projects/daemon-binding");

describe("GET /api/projects/[projectId]/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(resolveProjectAgentsRegistry).mockResolvedValue([]);
  });

  it("returns only the owned project's registered picker fields", async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "project-1",
      daemonHost: "daemon-a",
      workspacePath: "/repo/project",
    } as any);
    vi.mocked(resolveProjectAgentsRegistry).mockResolvedValue([
      {
        name: "feature-dev",
        doc: "private/personas/feature.md",
        description: "Builds features",
        backend: "codex",
      },
    ]);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:6152/api/projects/project-1/agents",
      }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: { id: "project-1", userId: "user-1" },
      select: { id: true, daemonHost: true, workspacePath: true },
    });
    expect(resolveProjectAgentsRegistry).toHaveBeenCalledWith({
      userId: "user-1",
      daemonHost: "daemon-a",
      workspacePath: "/repo/project",
    });
    expect(data).toEqual({
      agents: [
        {
          name: "feature-dev",
          description: "Builds features",
          backend: "codex",
        },
      ],
    });
    expect(data.agents[0]).not.toHaveProperty("doc");
  });

  it("returns 404 without reading settings when the project is not owned", async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue(null);

    const response = await GET(
      createMockRequest({
        url: "http://localhost:6152/api/projects/missing/agents",
      }),
      { params: Promise.resolve({ projectId: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(resolveProjectAgentsRegistry).not.toHaveBeenCalled();
  });

  it("passes through the authentication response", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 }) as any,
    );

    const response = await GET(
      createMockRequest({
        url: "http://localhost:6152/api/projects/project-1/agents",
      }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(401);
    expect(db.project.findFirst).not.toHaveBeenCalled();
  });
});
