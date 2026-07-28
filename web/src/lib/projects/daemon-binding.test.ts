import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveProjectAgentsRegistry,
  validateProjectBindingWithDaemon,
} from "./daemon-binding";

const { realtimeHubMock, readProjectAgentsRegistryMock } = vi.hoisted(() => ({
  realtimeHubMock: {
    hasAgentHost: vi.fn(),
    getAgentsForUser: vi.fn(),
    waitForProjectPathValidation: vi.fn(),
    waitForProjectAgents: vi.fn(),
    sendToAgentHost: vi.fn(),
    cancelProjectPathValidation: vi.fn(),
    cancelProjectAgents: vi.fn(),
  },
  readProjectAgentsRegistryMock: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: realtimeHubMock,
}));

vi.mock("@/lib/projects/project-settings-yaml", () => ({
  readProjectAgentsRegistry: readProjectAgentsRegistryMock,
}));

describe("validateProjectBindingWithDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readProjectAgentsRegistryMock.mockResolvedValue([]);
    realtimeHubMock.getAgentsForUser.mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-a",
        supportedBackends: ["claude"],
        capabilities: ["project_path_validation", "project_agents_registry"],
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
      last_commit_at: "2026-05-12T14:30:00.000Z",
      file_count: 12,
      agents: [
        {
          name: "reviewer",
          doc: "agents/reviewer.md",
          description: "Reviews work",
          backend: "codex",
        },
      ],
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
      lastCommitAt: "2026-05-12T14:30:00.000Z",
      gitRemoteUrl: null,
      fileCount: 12,
      agents: [
        {
          name: "reviewer",
          doc: "agents/reviewer.md",
          description: "Reviews work",
          backend: "codex",
        },
      ],
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
      last_commit_at: null,
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

describe("resolveProjectAgentsRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readProjectAgentsRegistryMock.mockResolvedValue([
      {
        name: "local",
        doc: "agents/local.md",
        description: null,
        backend: null,
      },
    ]);
    realtimeHubMock.getAgentsForUser.mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["project_path_validation", "project_agents_registry"],
      },
    ]);
  });

  it("prefers the live daemon registry for a remote workspace", async () => {
    realtimeHubMock.hasAgentHost.mockReturnValue(true);
    realtimeHubMock.sendToAgentHost.mockReturnValue(true);
    realtimeHubMock.waitForProjectAgents.mockResolvedValue({
      request_id: "req-agents",
      daemon_host: "daemon-a",
      workspace_path: "/remote/repo",
      agents: [
        {
          name: "remote",
          doc: "personas/remote.md",
          description: null,
          backend: "codex",
        },
      ],
      error: null,
      error_code: null,
      resolved_at: "2026-07-28T00:00:00.000Z",
    });

    await expect(
      resolveProjectAgentsRegistry({
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/remote/repo",
      }),
    ).resolves.toEqual([
      {
        name: "remote",
        doc: "personas/remote.md",
        description: null,
        backend: "codex",
      },
    ]);
    expect(realtimeHubMock.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "daemon-a",
      expect.objectContaining({
        type: "get_project_agents",
        payload: expect.objectContaining({ workspace_path: "/remote/repo" }),
      }),
    );
    expect(realtimeHubMock.waitForProjectPathValidation).not.toHaveBeenCalled();
  });

  it("falls back to the local registry when the daemon is offline", async () => {
    realtimeHubMock.hasAgentHost.mockReturnValue(false);

    await expect(
      resolveProjectAgentsRegistry({
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/local/repo",
      }),
    ).resolves.toEqual([
      {
        name: "local",
        doc: "agents/local.md",
        description: null,
        backend: null,
      },
    ]);
    expect(realtimeHubMock.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("falls back locally without path validation for an older daemon", async () => {
    realtimeHubMock.hasAgentHost.mockReturnValue(true);
    realtimeHubMock.getAgentsForUser.mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["project_path_validation"],
      },
    ]);

    await expect(
      resolveProjectAgentsRegistry({
        userId: "user-1",
        daemonHost: "daemon-a",
        workspacePath: "/local/repo",
      }),
    ).resolves.toEqual([
      {
        name: "local",
        doc: "agents/local.md",
        description: null,
        backend: null,
      },
    ]);
    expect(realtimeHubMock.waitForProjectAgents).not.toHaveBeenCalled();
    expect(realtimeHubMock.waitForProjectPathValidation).not.toHaveBeenCalled();
    expect(realtimeHubMock.sendToAgentHost).not.toHaveBeenCalled();
  });
});
