import { describe, expect, it } from "vitest";
import {
  buildTaskWorktreeLaunchConfig,
  inheritTaskWorktreeLaunchConfig,
  resolveTaskWorktreeCwdFromLaunchConfig,
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

  it("builds launch config relative paths with win32 semantics", () => {
    const launchConfig = buildTaskWorktreeLaunchConfig({
      launchConfig: { backendType: "codex" },
      worktreeId: "task-1",
      projectRepoRoot: "C:\\repo",
      projectWorkspacePath: "C:\\repo\\packages\\app",
      projectWorktreeBranch: "main",
    });

    expect(launchConfig).toMatchObject({
      backendType: "codex",
      worktree: true,
      worktreeId: "task-1",
      worktreeBaseRef: "main",
      projectRepoRoot: "C:\\repo",
      projectWorkspacePath: "C:\\repo\\packages\\app",
      projectRelativePath: "packages\\app",
    });
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
