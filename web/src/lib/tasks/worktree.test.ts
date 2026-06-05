import { describe, expect, it } from "vitest";
import { resolveTaskWorktreeCwdFromLaunchConfig } from "./worktree";

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
