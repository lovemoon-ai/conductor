import { describe, expect, it } from "vitest";
import {
  getTaskWorktreeRootKey,
  hasSameTaskWorktreeRoot,
  inheritTaskWorktreeLaunchConfig,
  parseRemoteWorktreeLaunchConfig,
  resolveTaskWorktreeCleanupPlan,
  resolveTaskWorktreeCwdFromLaunchConfig,
  toRemoteWorktreeCleanupLaunchConfig,
} from "./worktree";

describe("resolveTaskWorktreeCwdFromLaunchConfig", () => {
  it("returns null for non-worktree launch configs", () => {
    expect(resolveTaskWorktreeCwdFromLaunchConfig(null)).toBeNull();
    expect(resolveTaskWorktreeCwdFromLaunchConfig({})).toBeNull();
    expect(resolveTaskWorktreeCwdFromLaunchConfig({ cwd: "/repo" })).toBeNull();
    expect(
      resolveTaskWorktreeCwdFromLaunchConfig({ worktree: false }),
    ).toBeNull();
  });

  it("resolves the worktree root for POSIX paths when projectRelativePath is '.'", () => {
    expect(
      resolveTaskWorktreeCwdFromLaunchConfig({
        worktree: true,
        worktreeId: "ai-1",
        worktreeBranch: "feature/login",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo",
        projectRelativePath: ".",
      }),
    ).toBe("/repo/.conductor/worktrees/feature_login");
  });

  it("appends projectRelativePath when the project is a subdirectory of the repo root", () => {
    // Mirrors the daemon's `resolveTaskWorktreeCwd` which joins
    // projectRelativePath onto the worktree root.
    expect(
      resolveTaskWorktreeCwdFromLaunchConfig({
        worktree: true,
        worktreeId: "ai-1",
        worktreeBranch: "fix/buttons",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo/apps/web",
        projectRelativePath: "apps/web",
      }),
    ).toBe("/repo/apps/web/.conductor/worktrees/fix_buttons/apps/web");
  });

  it("uses win32 separators when projectWorkspacePath looks Windows-style", () => {
    // A drive-letter prefix is enough to flip `selectPathApi` into win32.
    // Daemon-side `path.join` would produce the same result on a Windows
    // host. This pins the cross-platform contract documented on the helper.
    expect(
      resolveTaskWorktreeCwdFromLaunchConfig({
        worktree: true,
        worktreeId: "ai-1",
        worktreeBranch: "feature/login",
        worktreeBaseRef: "main",
        projectRepoRoot: "C:\\repo",
        projectWorkspacePath: "C:\\repo",
        projectRelativePath: ".",
      }),
    ).toBe("C:\\repo\\.conductor\\worktrees\\feature_login");
  });

  it("inheritTaskWorktreeLaunchConfig returns null for non-worktree configs", () => {
    expect(inheritTaskWorktreeLaunchConfig(null)).toBeNull();
    expect(inheritTaskWorktreeLaunchConfig({})).toBeNull();
    expect(inheritTaskWorktreeLaunchConfig({ cwd: "/repo" })).toBeNull();
    // Missing required fields (no worktreeId / projectRepoRoot / etc.) must
    // refuse to "inherit a worktree" — silently returning a partial config
    // would route the successor to the project root and lose workspace
    // continuity.
    expect(
      inheritTaskWorktreeLaunchConfig({
        worktree: true,
        worktreeBranch: "abc",
      }),
    ).toBeNull();
  });

  it("inheritTaskWorktreeLaunchConfig preserves the source's worktree identity", () => {
    // The "new task from this" workspace contract: the successor must land in
    // the SAME on-disk folder as the source. Folder identity is keyed off the
    // sanitised worktreeBranch, so the inherited launch_config MUST keep the
    // same worktreeBranch (and resolve to the same cwd). If this changes the
    // user's "continue this work" intent silently breaks.
    const source = {
      worktree: true,
      worktreeId: "task-original",
      worktreeBranch: "feature/login",
      worktreeBaseRef: "main",
      projectRepoRoot: "/repo",
      projectWorkspacePath: "/repo",
      projectRelativePath: ".",
    };
    const inherited = inheritTaskWorktreeLaunchConfig(source);
    expect(inherited).toMatchObject({
      worktree: true,
      worktreeBranch: "feature/login",
      worktreeBaseRef: "main",
      projectRepoRoot: "/repo",
      projectWorkspacePath: "/repo",
      projectRelativePath: ".",
    });
    expect(resolveTaskWorktreeCwdFromLaunchConfig(inherited)).toBe(
      resolveTaskWorktreeCwdFromLaunchConfig(source),
    );
  });

  // Regression: restart goes through inheritTaskWorktreeLaunchConfig WITHOUT
  // options (see api/tasks/[taskId]/restart/route.ts and lib/tasks/
  // inplace-restart.ts). If the flag were only written when the caller asks
  // for it, restarting a reviewer would silently promote it back into a
  // worktree owner that runs `git worktree add -b` against the branch its
  // still-running worker owns.
  it("inheritTaskWorktreeLaunchConfig keeps reuse-only across a restart", () => {
    const reviewer = {
      worktree: true,
      worktreeId: "task-worker",
      worktreeBranch: "shared-branch",
      worktreeBaseRef: "main",
      projectRepoRoot: "/repo",
      projectWorkspacePath: "/repo",
      projectRelativePath: ".",
      worktreeReuseOnly: true,
    };

    // No options: exactly how both restart paths call it.
    expect(inheritTaskWorktreeLaunchConfig(reviewer)?.worktreeReuseOnly).toBe(true);
    // Snake_case alias, as the daemon may round-trip it.
    expect(
      inheritTaskWorktreeLaunchConfig({
        ...reviewer,
        worktreeReuseOnly: undefined,
        worktree_reuse_only: true,
      })?.worktreeReuseOnly,
    ).toBe(true);
    // An owner must NOT acquire the flag.
    expect(
      inheritTaskWorktreeLaunchConfig({ ...reviewer, worktreeReuseOnly: false })
        ?.worktreeReuseOnly,
    ).toBeUndefined();
  });

  it("inheritTaskWorktreeLaunchConfig accepts snake_case fields written by the daemon", () => {
    // Both web and daemon parsers tolerate snake_case aliases (see
    // parseTaskWorktreeLaunchConfig). The inheritance helper sits on top of
    // that parser, so a launch_config written by an older daemon (snake_case)
    // must still produce a valid inherited config.
    const inherited = inheritTaskWorktreeLaunchConfig({
      worktree: true,
      worktree_id: "task-original",
      worktree_branch: "fix/buttons",
      worktree_base_ref: "main",
      project_repo_root: "/repo",
      project_workspace_path: "/repo/apps/web",
      project_relative_path: "apps/web",
    });
    expect(inherited).toMatchObject({
      worktreeBranch: "fix/buttons",
      projectWorkspacePath: "/repo/apps/web",
      projectRelativePath: "apps/web",
    });
  });

  it("sanitises path separators in the worktree branch name (matches daemon's buildTaskWorktreeRoot)", () => {
    // Two branches that sanitise to the same folder must produce the same
    // path. The daemon uses `String(branch).replace(/[/\\]/g, "_")`.
    const a = resolveTaskWorktreeCwdFromLaunchConfig({
      worktree: true,
      worktreeId: "ai-1",
      worktreeBranch: "user/spike",
      worktreeBaseRef: "main",
      projectRepoRoot: "/repo",
      projectWorkspacePath: "/repo",
      projectRelativePath: ".",
    });
    const b = resolveTaskWorktreeCwdFromLaunchConfig({
      worktree: true,
      worktreeId: "ai-1",
      worktreeBranch: "user\\spike",
      worktreeBaseRef: "main",
      projectRepoRoot: "/repo",
      projectWorkspacePath: "/repo",
      projectRelativePath: ".",
    });
    expect(a).toBe(b);
    expect(a).toBe("/repo/.conductor/worktrees/user_spike");
  });
});

describe("remote worktree launch config (RFC 0038)", () => {
  const remote = {
    host: "ubuntu",
    projectId: "proj-b",
    repoRoot: "/home/b/repo",
    workspacePath: "/home/b/repo",
    branch: "f8bc83",
    baseRef: "main",
  };
  const local = {
    worktree: true,
    worktreeId: "task-1",
    worktreeBranch: "f8bc83",
    worktreeBaseRef: "main",
    projectRepoRoot: "/home/b/repo",
    projectWorkspacePath: "/home/b/repo",
    projectRelativePath: ".",
  };

  it("parseRemoteWorktreeLaunchConfig reads camelCase and snake_case and defaults baseRef", () => {
    expect(parseRemoteWorktreeLaunchConfig(null)).toBeNull();
    expect(parseRemoteWorktreeLaunchConfig(local)).toBeNull();
    // A bare host is a request, not a resolved config.
    expect(parseRemoteWorktreeLaunchConfig({ remoteWorktree: { host: "ubuntu" } })).toBeNull();
    expect(parseRemoteWorktreeLaunchConfig({ remoteWorktree: remote })).toEqual(remote);
    expect(
      parseRemoteWorktreeLaunchConfig(
        JSON.stringify({
          remote_worktree: {
            host: "ubuntu",
            project_id: "proj-b",
            repo_root: "/home/b/repo",
            workspace_path: "/home/b/repo",
            branch: "f8bc83",
          },
        }),
      ),
    ).toEqual({ ...remote, baseRef: "HEAD" });
  });

  it("toRemoteWorktreeCleanupLaunchConfig produces the shape the remote daemon's cleanup handler expects", () => {
    const translated = toRemoteWorktreeCleanupLaunchConfig({
      ...remote,
      workspacePath: "/home/b/repo/web",
    });
    expect(translated).toEqual({
      worktree: true,
      worktreeId: "proj-b",
      worktreeBranch: "f8bc83",
      worktreeBaseRef: "main",
      projectRepoRoot: "/home/b/repo",
      projectWorkspacePath: "/home/b/repo/web",
      projectRelativePath: "web",
    });
    // The translated config resolves to the folder the AI was told to create.
    expect(resolveTaskWorktreeCwdFromLaunchConfig(translated)).toBe(
      "/home/b/repo/web/.conductor/worktrees/f8bc83/web",
    );
  });

  it("hasSameTaskWorktreeRoot compares remote worktrees by host, workspace and branch", () => {
    const reference = { remoteWorktree: remote, cwd: "/Users/a/repo" };
    expect(hasSameTaskWorktreeRoot(reference, { remoteWorktree: { ...remote } })).toBe(true);
    expect(hasSameTaskWorktreeRoot(reference, { remoteWorktree: { ...remote, host: "other" } })).toBe(false);
    expect(hasSameTaskWorktreeRoot(reference, { remoteWorktree: { ...remote, branch: "abcdef" } })).toBe(false);
    // Same path on the launching daemon is a different directory on a different disk.
    expect(hasSameTaskWorktreeRoot(reference, local)).toBe(false);
    expect(hasSameTaskWorktreeRoot(local, reference)).toBe(false);
    expect(getTaskWorktreeRootKey(reference)).toContain("ubuntu");
    expect(getTaskWorktreeRootKey(reference)).not.toBe(getTaskWorktreeRootKey(local));
  });

  it("inheritTaskWorktreeLaunchConfig carries a remote worktree (and the local cwd) to the successor", () => {
    expect(
      inheritTaskWorktreeLaunchConfig({ remoteWorktree: remote, cwd: "/Users/a/repo", initialContent: "x" }),
    ).toEqual({ remoteWorktree: remote, cwd: "/Users/a/repo" });
    expect(inheritTaskWorktreeLaunchConfig({ remoteWorktree: remote })).toEqual({ remoteWorktree: remote });
  });

  it("resolveTaskWorktreeCleanupPlan sends a remote worktree to its own daemon with a translated config", () => {
    expect(resolveTaskWorktreeCleanupPlan({ cwd: "/x" }, "daemon-a")).toBeNull();
    expect(resolveTaskWorktreeCleanupPlan(local, "daemon-a")).toEqual({
      agentHost: "daemon-a",
      launchConfig: local,
    });
    expect(resolveTaskWorktreeCleanupPlan(local, null)).toBeNull();
    // The local cleanup host is irrelevant for a remote worktree.
    expect(resolveTaskWorktreeCleanupPlan({ remoteWorktree: remote }, "daemon-a")).toEqual({
      agentHost: "ubuntu",
      launchConfig: toRemoteWorktreeCleanupLaunchConfig(remote),
    });
    expect(resolveTaskWorktreeCleanupPlan({ remoteWorktree: remote }, null)?.agentHost).toBe("ubuntu");
  });
});
