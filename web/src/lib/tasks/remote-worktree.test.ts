import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { project: { findFirst: vi.fn() } },
}));

const { db } = await import("@/lib/db");
const {
  buildRemoteWorktreeBootstrap,
  readRemoteWorktreeRequestHost,
  resolveRemoteWorktreePaths,
  resolveRemoteWorktreeTarget,
} = await import("./remote-worktree");

const projectA = {
  id: "proj-a",
  name: "conductor",
  daemonHost: "macmini",
  workspacePath: "/Users/a/ws/conductor",
  gitRemoteUrl: "github.com/lovemoon-ai/conductor",
  mergeOptOut: false,
};
const projectB = {
  id: "proj-b",
  name: "conductor",
  userId: "user-1",
  daemonHost: "ubuntu",
  workspacePath: "/home/b/ws/conductor",
  repoRoot: "/home/b/ws/conductor",
  worktreeBranch: "main",
  lastCommit: "abc1234",
  // A different SSH alias for the same GitHub repo still counts as the same project.
  gitRemoteUrl: "github-dang217/lovemoon-ai/conductor",
  mergeOptOut: false,
};
const bothOnline = [
  { host: "macmini", capabilities: ["remote_exec", "remote_file"] },
  { host: "ubuntu", capabilities: ["remote_exec", "remote_file"] },
];
const remote = {
  host: "ubuntu",
  projectId: "proj-b",
  repoRoot: "/home/b/ws/conductor",
  workspacePath: "/home/b/ws/conductor",
  branch: "f8bc83",
  baseRef: "main",
};

describe("readRemoteWorktreeRequestHost", () => {
  it("returns the requested host from either key and null otherwise", () => {
    expect(readRemoteWorktreeRequestHost(null)).toBeNull();
    expect(readRemoteWorktreeRequestHost({ worktree: true })).toBeNull();
    expect(readRemoteWorktreeRequestHost({ remoteWorktree: {} })).toBeNull();
    expect(readRemoteWorktreeRequestHost({ remoteWorktree: { host: " ubuntu " } })).toBe("ubuntu");
    expect(readRemoteWorktreeRequestHost({ remote_worktree: { host: "ubuntu" } })).toBe("ubuntu");
  });
});

describe("resolveRemoteWorktreeTarget", () => {
  beforeEach(() => {
    vi.mocked(db.project.findFirst).mockReset();
    vi.mocked(db.project.findFirst).mockResolvedValue(projectB as any);
  });

  const resolve = (overrides: Partial<Parameters<typeof resolveRemoteWorktreeTarget>[0]> = {}) =>
    resolveRemoteWorktreeTarget({
      userId: "user-1",
      project: projectA,
      requestedHost: "ubuntu",
      connectedAgents: bothOnline,
      ...overrides,
    });

  it("mints a remoteWorktree from the sibling project on the requested daemon", async () => {
    const result = await resolve();
    expect(result).toEqual({
      remoteWorktree: {
        host: "ubuntu",
        projectId: "proj-b",
        repoRoot: "/home/b/ws/conductor",
        workspacePath: "/home/b/ws/conductor",
        branch: expect.stringMatching(/^[0-9a-f]{6}$/),
        baseRef: "main",
      },
    });
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", daemonHost: "ubuntu", name: "conductor" },
    });
  });

  it("falls back to the sibling's last commit, then HEAD, for the base ref", async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ ...projectB, worktreeBranch: null } as any);
    expect(((await resolve()) as any).remoteWorktree.baseRef).toBe("abc1234");
    vi.mocked(db.project.findFirst).mockResolvedValue({
      ...projectB,
      worktreeBranch: null,
      lastCommit: null,
    } as any);
    expect(((await resolve()) as any).remoteWorktree.baseRef).toBe("HEAD");
  });

  it("rejects a daemon_share token: the scope scanner cannot see remoteWorktree.host", async () => {
    expect(await resolve({ tokenScope: "daemon_share" })).toEqual({
      error: expect.stringContaining("shared daemon token"),
      status: 403,
    });
    expect(db.project.findFirst).not.toHaveBeenCalled();
    expect("remoteWorktree" in ((await resolve({ tokenScope: "full" })) as object)).toBe(true);
  });

  it("rejects an unbound launching project", async () => {
    expect(await resolve({ project: { ...projectA, daemonHost: null, workspacePath: null } })).toEqual({
      error: expect.stringContaining("bound on the launching daemon"),
      status: 409,
    });
  });

  it("rejects the project's own daemon as the remote host", async () => {
    expect(await resolve({ requestedHost: "macmini" })).toEqual({
      error: expect.stringContaining("different daemon"),
      status: 409,
    });
  });

  it("rejects an offline daemon and one missing a required capability", async () => {
    expect(await resolve({ connectedAgents: [bothOnline[0]] })).toEqual({
      error: "Remote worktree daemon ubuntu is offline",
      status: 409,
    });
    expect(
      await resolve({
        connectedAgents: [bothOnline[0], { host: "ubuntu", capabilities: ["remote_exec"] }],
      }),
    ).toEqual({ error: expect.stringContaining("does not support remote_file"), status: 409 });
  });

  it("rejects when the same project is not bound on the remote daemon", async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue(null);
    expect(await resolve()).toEqual({
      error: 'Project "conductor" is not bound on daemon ubuntu',
      status: 409,
    });
    // Same name but a different repository is not the same project.
    vi.mocked(db.project.findFirst).mockResolvedValue({
      ...projectB,
      gitRemoteUrl: "github.com/other/conductor",
    } as any);
    expect((await resolve()) as any).toMatchObject({ status: 409 });
  });

  it("rejects a sibling that is not a git repository", async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ ...projectB, repoRoot: null } as any);
    expect(await resolve()).toEqual({
      error: expect.stringContaining("is not a git repository"),
      status: 409,
    });
  });
});

describe("buildRemoteWorktreeBootstrap", () => {
  it("names the host, the exact worktree command, the read-only local clone and the task", () => {
    const text = buildRemoteWorktreeBootstrap({
      remoteWorktree: remote,
      localWorkspacePath: "/Users/a/ws/conductor",
      taskPrompt: "  Fix the flaky test  ",
    });
    expect(text.startsWith("[conductor:remote-worktree]")).toBe(true);
    expect(text).toContain('daemon "ubuntu"');
    expect(text).toContain("/Users/a/ws/conductor) is a READ-ONLY copy");
    expect(text).toContain("conductor remote exec -t ubuntu -w <dir> -- <argv>");
    expect(text).toContain("set -euo pipefail");
    expect(text).toContain(
      "git worktree add -b f8bc83 /home/b/ws/conductor/.conductor/worktrees/f8bc83 main",
    );
    expect(text).toContain("-w /home/b/ws/conductor/.conductor/worktrees/f8bc83 for every command");
    expect(text).toContain("conductor remote wait -t ubuntu <runId>");
    expect(text).toContain("Never run `conductor` itself through remote exec");
    expect(text.endsWith("--- Task ---\nFix the flaky test")).toBe(true);
  });

  it("keeps a /goal directive on the first line so fire still enters goal mode", () => {
    const text = buildRemoteWorktreeBootstrap({
      remoteWorktree: remote,
      localWorkspacePath: null,
      taskPrompt: "/goal\nShip the login page\nwith tests",
    });
    expect(text.split("\n")[0]).toBe("/goal");
    expect(text.split("\n")[1].startsWith("[conductor:remote-worktree]")).toBe(true);
    expect(text.endsWith("--- Task ---\nShip the login page\nwith tests")).toBe(true);

    const inline = buildRemoteWorktreeBootstrap({
      remoteWorktree: remote,
      localWorkspacePath: null,
      taskPrompt: "/GOAL fix flaky test",
    });
    expect(inline.startsWith("/GOAL fix flaky test\n[conductor:remote-worktree]")).toBe(true);
    expect(inline).not.toContain("--- Task ---");
  });

  it("omits the local-clone notice and the task section when there is neither", () => {
    const text = buildRemoteWorktreeBootstrap({ remoteWorktree: remote, localWorkspacePath: null });
    expect(text).not.toContain("READ-ONLY");
    expect(text).not.toContain("--- Task ---");
    expect(text.endsWith("conductor cleans it up.")).toBe(true);
  });

  it("points the work dir at the project subdirectory inside the worktree", () => {
    const nested = { ...remote, workspacePath: "/home/b/ws/conductor/web" };
    expect(resolveRemoteWorktreePaths(nested)).toEqual({
      worktreeRoot: "/home/b/ws/conductor/web/.conductor/worktrees/f8bc83",
      workDir: "/home/b/ws/conductor/web/.conductor/worktrees/f8bc83/web",
    });
    const text = buildRemoteWorktreeBootstrap({ remoteWorktree: nested, localWorkspacePath: null });
    expect(text).toContain("work dir:         /home/b/ws/conductor/web/.conductor/worktrees/f8bc83/web");
  });
});
