import type { Project } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrismaQuery } from "@/__tests__/mock-prisma-query";

vi.mock("@/lib/db", () => ({
  db: {
    project: { findFirst: vi.fn() },
    daemonShare: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/user-preferences", () => ({
  getGlobalAiBackends: vi.fn(),
}));
vi.mock("@/lib/auth/service", () => ({
  ensureDefaultProject: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { getGlobalAiBackends } = await import("@/lib/user-preferences");
const { ensureDefaultProject } = await import("@/lib/auth/service");
const { readGlobalBackendRequest, readTaskGlobalBackend, resolveGlobalBackendMount } =
  await import("./global-backend");

const findFirst = mockPrismaQuery(db.project.findFirst);
const findShares = mockPrismaQuery(db.daemonShare.findMany);

// The project the user starts from: code lives on macmini.
const project = {
  id: "proj-a",
  userId: "user-1",
  name: "conductor",
  daemonHost: "macmini",
  workspacePath: "/Users/a/ws/conductor/web",
  repoRoot: "/Users/a/ws/conductor",
  worktreeBranch: "main",
  lastCommit: "abc1234",
  gitRemoteUrl: "github.com/lovemoon-ai/conductor",
  mergeOptOut: false,
} as unknown as Project;

// The same repo bound on the AI daemon (ubuntu).
const sibling = {
  id: "proj-b",
  userId: "user-1",
  name: "conductor",
  daemonHost: "ubuntu",
  workspacePath: "/home/b/ws/conductor",
  repoRoot: "/home/b/ws/conductor",
  gitRemoteUrl: "github-dang217/lovemoon-ai/conductor",
  mergeOptOut: false,
} as unknown as Project;

const defaultProject = {
  id: "proj-default",
  userId: "user-1",
  name: "Default Project",
  daemonHost: null,
  workspacePath: null,
} as unknown as Project;

const bothOnline = [
  { host: "macmini", capabilities: ["remote_exec", "remote_file"] },
  { host: "ubuntu", capabilities: ["remote_exec", "remote_file"] },
];

const request = { host: "ubuntu", backend: "codex" };

const resolve = (overrides: Partial<Parameters<typeof resolveGlobalBackendMount>[0]> = {}) =>
  resolveGlobalBackendMount({
    userId: "user-1",
    project,
    request,
    worktree: false,
    connectedAgents: bothOnline,
    ...overrides,
  });

describe("readGlobalBackendRequest", () => {
  it("returns null when absent or false", () => {
    expect(readGlobalBackendRequest({})).toBeNull();
    expect(readGlobalBackendRequest({ global_backend: null })).toBeNull();
    expect(readGlobalBackendRequest({ globalBackend: false })).toBeNull();
  });

  it("reads camelCase and snake_case keys and lowercases the backend", () => {
    expect(readGlobalBackendRequest({ globalBackend: { host: " ubuntu ", backend: "Codex" } })).toEqual(
      { host: "ubuntu", backend: "codex" },
    );
    expect(readGlobalBackendRequest({ global_backend: { host: "ubuntu", backend: "CLAUDE" } })).toEqual({
      host: "ubuntu",
      backend: "claude",
    });
    expect(
      readGlobalBackendRequest({ global_backend: JSON.stringify({ host: "ubuntu", backend: "codex" }) }),
    ).toEqual({ host: "ubuntu", backend: "codex" });
  });

  it("rejects a request without host or backend with 400", () => {
    expect(readGlobalBackendRequest({ globalBackend: { host: "ubuntu" } })).toEqual({
      error: "global_backend requires host and backend",
      status: 400,
    });
    expect(readGlobalBackendRequest({ globalBackend: { backend: "codex" } })).toMatchObject({ status: 400 });
    expect(readGlobalBackendRequest({ globalBackend: true })).toMatchObject({ status: 400 });
  });
});

describe("readTaskGlobalBackend", () => {
  it("reads object and JSON-string metadata", () => {
    expect(readTaskGlobalBackend({ globalBackend: { host: "ubuntu", backend: "codex" } })).toEqual({
      host: "ubuntu",
      backend: "codex",
    });
    expect(
      readTaskGlobalBackend(JSON.stringify({ globalBackend: { host: "ubuntu", backend: "codex" } })),
    ).toEqual({ host: "ubuntu", backend: "codex" });
  });

  it("returns null for missing or malformed metadata", () => {
    expect(readTaskGlobalBackend(null)).toBeNull();
    expect(readTaskGlobalBackend("{not json")).toBeNull();
    expect(readTaskGlobalBackend({})).toBeNull();
    expect(readTaskGlobalBackend({ globalBackend: { host: "ubuntu" } })).toBeNull();
    expect(readTaskGlobalBackend({ globalBackend: "oops" })).toBeNull();
  });
});

describe("resolveGlobalBackendMount", () => {
  beforeEach(() => {
    vi.mocked(getGlobalAiBackends).mockReset();
    vi.mocked(getGlobalAiBackends).mockResolvedValue([{ host: "ubuntu", backend: "codex" }]);
    vi.mocked(ensureDefaultProject).mockReset();
    vi.mocked(ensureDefaultProject).mockResolvedValue(defaultProject);
    findFirst.mockReset();
    findFirst.mockResolvedValue(sibling);
    findShares.mockReset();
    findShares.mockResolvedValue([]);
  });

  it("refuses a daemon_share token with 403", async () => {
    const result = await resolve({ tokenScope: "daemon_share" });
    expect(result).toMatchObject({ status: 403 });
    expect(getGlobalAiBackends).not.toHaveBeenCalled();
  });

  it("refuses a backend the user has not enabled with 409", async () => {
    expect(await resolve({ request: { host: "ubuntu", backend: "claude" } })).toEqual({
      error: "claude @ ubuntu is not one of your global AI backends",
      status: 409,
    });
    expect(await resolve({ request: { host: "other", backend: "codex" } })).toEqual({
      error: "codex @ other is not one of your global AI backends",
      status: 409,
    });
  });

  it("refuses a conductor-fire host even when it is listed", async () => {
    vi.mocked(getGlobalAiBackends).mockResolvedValue([{ host: "conductor-fire-abc", backend: "codex" }]);
    expect(await resolve({ request: { host: "conductor-fire-abc", backend: "codex" } })).toEqual({
      error: "codex @ conductor-fire-abc is not one of your global AI backends",
      status: 409,
    });
  });

  it("requires a project bound to a daemon", async () => {
    for (const unbound of [
      { ...project, daemonHost: null },
      { ...project, workspacePath: " " },
    ]) {
      expect(await resolve({ project: unbound as Project })).toEqual({
        error: "global_backend requires a project bound to a daemon",
        status: 409,
      });
    }
  });

  it("treats the project's own daemon as a local task", async () => {
    vi.mocked(getGlobalAiBackends).mockResolvedValue([{ host: "macmini", backend: "codex" }]);
    expect(await resolve({ request: { host: "macmini", backend: "codex" } })).toEqual({ local: true });
    expect(findShares).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(ensureDefaultProject).not.toHaveBeenCalled();
  });

  it("refuses hosts lent through an active DaemonShare with 403", async () => {
    for (const guestHost of ["ubuntu", "macmini"]) {
      findShares.mockResolvedValueOnce([{ guestHost } as never]);
      const result = await resolve();
      expect(result).toMatchObject({ status: 403 });
      expect((result as { error: string }).error).toContain(`${guestHost} is shared with you`);
    }
    expect(findShares).toHaveBeenCalledWith({
      where: { granteeUserId: "user-1", status: "active", guestHost: { in: ["ubuntu", "macmini"] } },
      select: { guestHost: true },
    });
  });

  it("requires the project daemon to be online with remote_exec and remote_file", async () => {
    expect(await resolve({ connectedAgents: [bothOnline[1]] })).toEqual({
      error: "Remote worktree daemon macmini is offline",
      status: 409,
    });
    const missing = await resolve({
      connectedAgents: [{ host: "macmini", capabilities: ["remote_exec"] }, bothOnline[1]],
    });
    expect(missing).toMatchObject({ status: 409 });
    expect((missing as { error: string }).error).toContain("remote_file");
  });

  it("requires the project to be a git repository", async () => {
    expect(await resolve({ project: { ...project, repoRoot: null } as Project })).toEqual({
      error: 'Project "conductor" on daemon macmini is not a git repository',
      status: 409,
    });
  });

  it("mounts on a mergeable sibling on the AI daemon in direct mode", async () => {
    const result = await resolve();
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", daemonHost: "ubuntu", name: "conductor" },
    });
    expect(ensureDefaultProject).not.toHaveBeenCalled();
    expect(result).toEqual({
      mountProject: sibling,
      secondProjectId: "proj-a",
      agentHost: "ubuntu",
      backend: "codex",
      localClonePath: "/home/b/ws/conductor",
      remoteWorktree: null,
      remoteWorkspace: {
        host: "macmini",
        projectId: "proj-a",
        repoRoot: "/Users/a/ws/conductor",
        workspacePath: "/Users/a/ws/conductor/web",
      },
      metadata: { globalBackend: { host: "ubuntu", backend: "codex" } },
    });
  });

  it("falls back to the default project when the sibling is not mergeable or missing", async () => {
    for (const candidate of [
      { ...sibling, gitRemoteUrl: "github.com/someone/else" },
      { ...sibling, mergeOptOut: true },
      null,
    ]) {
      findFirst.mockResolvedValueOnce(candidate as Project | null);
      const result = await resolve();
      expect(result).toMatchObject({ mountProject: defaultProject, secondProjectId: "proj-a" });
    }
    expect(ensureDefaultProject).toHaveBeenCalledTimes(3);
    expect(ensureDefaultProject).toHaveBeenCalledWith("user-1");
  });

  it("never offers an unrelated default-project dir as the AI's local clone", async () => {
    findFirst.mockResolvedValueOnce(null);
    vi.mocked(ensureDefaultProject).mockResolvedValueOnce(
      { ...defaultProject, daemonHost: "ubuntu", workspacePath: "/home/b/default" } as unknown as Project,
    );
    const result = await resolve();
    expect(result).toMatchObject({ agentHost: "ubuntu", localClonePath: null });
  });

  it("refuses a default project bound to a daemon other than the AI's", async () => {
    findFirst.mockResolvedValueOnce(null);
    vi.mocked(ensureDefaultProject).mockResolvedValueOnce(
      { ...defaultProject, daemonHost: "studio", workspacePath: "/Users/s/default" } as unknown as Project,
    );
    const result = await resolve();
    expect(result).toMatchObject({ status: 409 });
    expect((result as { error: string }).error).toMatch(/default project is bound to studio/);
  });

  it("mints a remote worktree when worktree is requested", async () => {
    const result = await resolve({ worktree: true });
    expect(result).toMatchObject({
      mountProject: sibling,
      remoteWorkspace: null,
      remoteWorktree: {
        host: "macmini",
        projectId: "proj-a",
        repoRoot: "/Users/a/ws/conductor",
        workspacePath: "/Users/a/ws/conductor/web",
        baseRef: "main",
      },
      metadata: { globalBackend: { host: "ubuntu", backend: "codex" } },
    });
    expect((result as { remoteWorktree: { branch: string } }).remoteWorktree.branch).toMatch(
      /^[0-9a-f]{6}$/,
    );
  });

  it("derives baseRef from worktreeBranch, then lastCommit, then HEAD", async () => {
    const baseRefOf = async (overrides: Partial<Project>) => {
      const result = await resolve({ worktree: true, project: { ...project, ...overrides } as Project });
      return (result as { remoteWorktree: { baseRef: string } }).remoteWorktree.baseRef;
    };
    expect(await baseRefOf({})).toBe("main");
    expect(await baseRefOf({ worktreeBranch: null })).toBe("abc1234");
    expect(await baseRefOf({ worktreeBranch: null, lastCommit: null })).toBe("HEAD");
  });
});
