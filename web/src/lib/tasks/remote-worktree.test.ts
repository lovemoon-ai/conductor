import { describe, expect, it } from "vitest";
import {
  buildRemoteWorkspaceBootstrap,
  buildRemoteWorktreeBootstrap,
  checkRemoteDaemon,
  resolveRemoteTarget,
  resolveRemoteWorktreePaths,
} from "./remote-worktree";

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

describe("checkRemoteDaemon", () => {
  it("rejects an offline daemon and one missing a required capability", () => {
    expect(checkRemoteDaemon("ubuntu", bothOnline)).toBeNull();
    expect(checkRemoteDaemon("ubuntu", [bothOnline[0]])).toEqual({
      error: "Remote worktree daemon ubuntu is offline",
      status: 409,
    });
    expect(
      checkRemoteDaemon("ubuntu", [bothOnline[0], { host: "ubuntu", capabilities: ["remote_exec"] }]),
    ).toEqual({ error: expect.stringContaining("does not support remote_file"), status: 409 });
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
    expect(text).toContain("Start multi-step write/build scripts with `set -euo pipefail`");
    expect(text).toContain("leave it off read-only `... | head` queries");
    expect(text).not.toContain("Start every script with");
    expect(text).toContain(
      "git worktree add -b f8bc83 /home/b/ws/conductor/.conductor/worktrees/f8bc83 main",
    );
    expect(text).toContain("-w /home/b/ws/conductor/.conductor/worktrees/f8bc83 for every command");
    expect(text).toContain("conductor remote wait -t ubuntu <runId>");
    expect(text).toContain("Never run `conductor` itself through remote exec");
    // RFC 0040: fire may attach remote_* tools bound to the same work dir.
    expect(text).toContain(
      "remote_bash tools, they are already bound to ubuntu:/home/b/ws/conductor/.conductor/worktrees/f8bc83;",
    );
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

  it("RFC 0041: resolves a git-backed project row as a remote target, and rejects a non-git one", () => {
    expect(resolveRemoteTarget(projectB)).toEqual({
      host: "ubuntu",
      projectId: "proj-b",
      repoRoot: "/home/b/ws/conductor",
      workspacePath: "/home/b/ws/conductor",
      baseRef: "main",
    });
    expect(resolveRemoteTarget({ ...projectB, repoRoot: null })).toEqual({
      error: 'Project "conductor" on daemon ubuntu is not a git repository',
      status: 409,
    });
  });

  it("RFC 0041: the direct-mode bootstrap works in the project directory without creating a worktree", () => {
    const text = buildRemoteWorkspaceBootstrap({
      remoteWorkspace: {
        host: "ubuntu",
        projectId: "proj-b",
        repoRoot: "/home/b/ws/conductor",
        workspacePath: "/home/b/ws/conductor",
      },
      localWorkspacePath: null,
      taskPrompt: "Fix the build",
    });
    expect(text).toContain("[conductor:remote-workspace]");
    expect(text).toContain("conductor remote exec -t ubuntu -w <dir> -- <argv>");
    expect(text).toContain("Use -w /home/b/ws/conductor for every command");
    expect(text).not.toContain("git worktree add");
    expect(text).not.toContain("READ-ONLY copy");
    expect(text).toContain("Fix the build");
  });
});
