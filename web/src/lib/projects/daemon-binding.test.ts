import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateProjectBindingWithDaemon } from "./daemon-binding";

const { realtimeHubMock } = vi.hoisted(() => ({
  realtimeHubMock: {
    hasAgentHost: vi.fn(),
    getAgentsForUser: vi.fn(),
    waitForProjectPathValidation: vi.fn(),
    sendToAgentHost: vi.fn(),
    cancelProjectPathValidation: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: realtimeHubMock,
}));

describe("validateProjectBindingWithDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realtimeHubMock.getAgentsForUser.mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-a",
        supportedBackends: ["claude"],
        capabilities: ["project_path_validation"],
      },
    ]);
  });

  it("returns the confirmed binding from the daemon", async () => {
    realtimeHubMock.hasAgentHost.mockReturnValue(true);
    realtimeHubMock.waitForProjectPathValidation.mockResolvedValue({
      request_id: "req-1",
      daemon_host: "daemon-a",
      workspace_path: "/repo/alpha-real",
      repo_root: "/repo/alpha-real",
      worktree_branch: "main",
      last_commit: "abc123",
      file_count: 12,
      error: null,
      error_code: null,
      validated_at: "2026-04-03T10:00:00.000Z",
    });
    realtimeHubMock.sendToAgentHost.mockReturnValue(true);

    const result = await validateProjectBindingWithDaemon({
      userId: "user-1",
      daemonHost: "daemon-a",
      workspacePath: "/repo/alpha",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      daemonHost: "daemon-a",
      workspacePath: "/repo/alpha-real",
      repoRoot: "/repo/alpha-real",
      worktreeBranch: "main",
      lastCommit: "abc123",
      fileCount: 12,
    });
    expect(realtimeHubMock.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "daemon-a",
      expect.objectContaining({
        type: "validate_project_path",
        payload: expect.objectContaining({
          workspace_path: "/repo/alpha",
        }),
      }),
    );
  });

  it("throws a 400 validation error when the daemon rejects the workspace path", async () => {
    realtimeHubMock.hasAgentHost.mockReturnValue(true);
    realtimeHubMock.waitForProjectPathValidation.mockResolvedValue({
      request_id: "req-2",
      daemon_host: "daemon-a",
      workspace_path: null,
      repo_root: null,
      worktree_branch: null,
      last_commit: null,
      file_count: null,
      error: "Workspace path does not exist on daemon daemon-a: /repo/missing",
      error_code: "workspace_not_found",
      validated_at: "2026-04-03T10:00:00.000Z",
    });
    realtimeHubMock.sendToAgentHost.mockReturnValue(true);

    await expect(
      validateProjectBindingWithDaemon({
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/missing",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "ProjectBindingValidationError",
      status: 400,
      code: "workspace_not_found",
    });
  });

  it("throws when the daemon is offline", async () => {
    realtimeHubMock.hasAgentHost.mockReturnValue(false);

    await expect(
      validateProjectBindingWithDaemon({
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/alpha",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "ProjectBindingValidationError",
      status: 409,
      code: "daemon_offline",
    });
    expect(realtimeHubMock.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("fails fast when the daemon does not advertise project path validation", async () => {
    realtimeHubMock.hasAgentHost.mockReturnValue(true);
    realtimeHubMock.getAgentsForUser.mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-a",
        supportedBackends: ["claude"],
        capabilities: [],
      },
    ]);

    await expect(
      validateProjectBindingWithDaemon({
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/repo/alpha",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "ProjectBindingValidationError",
      status: 409,
      code: "daemon_upgrade_required",
    });
    expect(realtimeHubMock.waitForProjectPathValidation).not.toHaveBeenCalled();
    expect(realtimeHubMock.sendToAgentHost).not.toHaveBeenCalled();
  });
});
