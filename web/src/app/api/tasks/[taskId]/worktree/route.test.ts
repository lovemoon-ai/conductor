import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/tasks/[taskId]/worktree/route";
import { extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    hasAgentHost: vi.fn().mockReturnValue(true),
    waitForTaskWorktreeCleanup: vi.fn(),
    cancelTaskWorktreeCleanup: vi.fn(),
    sendToAgentHost: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");

const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe("/api/tasks/[taskId]/worktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === "function" ? callback({ task: db.task }) : callback,
    );
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      issueId: "issue-1",
      title: "Worktree Task",
      taskType: "ai_task",
      status: "completed",
      agentHost: "daemon-1",
      executionHost: "daemon-1",
      backendType: "codex",
      sessionId: "session-1",
      sessionFilePath: "/tmp/session-1.jsonl",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-1",
        worktreeBranch: "conductor/task/task-1",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo/app",
        projectRelativePath: "app",
      }),
      metadata: null,
      createdAt: new Date("2026-04-03T12:00:00.000Z"),
      updatedAt: new Date("2026-04-03T12:01:00.000Z"),
      project: {
        daemonHost: "daemon-1",
      },
    } as any);
    vi.mocked(realtimeHub.waitForTaskWorktreeCleanup).mockResolvedValue({
      request_id: "req-1",
      task_id: "task-1",
      daemon_host: "daemon-1",
      worktree_branch: "conductor/task/task-1",
      removed_path: "/tmp/worktrees/task-1",
      cleaned: true,
      error: null,
      cleaned_at: "2026-04-03T12:05:00.000Z",
    });
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValue({
      requestId: "req-1",
      delivered: true,
    } as any);
  });

  it("removes a stopped task worktree through the bound daemon", async () => {
    const response = await POST(
      new NextRequest("http://localhost:6152/api/tasks/task-1/worktree", {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.waitForTaskWorktreeCleanup).toHaveBeenCalledWith(
      expect.any(String),
      15000,
    );
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cleanup_task_worktree",
        agentHost: "daemon-1",
        taskId: "task-1",
        envelope: {
          type: "cleanup_task_worktree",
          payload: expect.objectContaining({
            task_id: "task-1",
            project_id: "proj-1",
            launch_config: expect.objectContaining({
              worktree: true,
              worktreeBranch: "conductor/task/task-1",
            }),
          }),
        },
      }),
      expect.any(Object),
    );
    expect(data).toEqual({
      task: expect.objectContaining({
        id: "task-1",
        issue_id: "issue-1",
        task_type: "ai_task",
      }),
      cleaned_at: "2026-04-03T12:05:00.000Z",
      removed_path: "/tmp/worktrees/task-1",
      worktree_branch: "conductor/task/task-1",
    });
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
      }),
    );
  });

  it("falls back to worktree task reads when issue relation columns are missing", async () => {
    vi.mocked(db.task.findFirst)
      .mockRejectedValueOnce(
        prismaError("P2022", "The column `tasks.issue_id` does not exist in the current database."),
      )
      .mockResolvedValueOnce({
        id: "task-1",
        projectId: "proj-1",
        title: "Worktree Task",
        taskType: "ai_task",
        status: "completed",
        agentHost: "daemon-1",
        executionHost: "daemon-1",
        backendType: "codex",
        sessionId: "session-1",
        sessionFilePath: "/tmp/session-1.jsonl",
        launchConfig: JSON.stringify({
          worktree: true,
          worktreeId: "task-1",
          worktreeBranch: "conductor/task/task-1",
          worktreeBaseRef: "main",
          projectRepoRoot: "/repo",
          projectWorkspacePath: "/repo/app",
          projectRelativePath: "app",
        }),
        metadata: null,
        createdAt: new Date("2026-04-03T12:00:00.000Z"),
        updatedAt: new Date("2026-04-03T12:01:00.000Z"),
        project: {
          daemonHost: "daemon-1",
        },
      } as any);

    const response = await POST(
      new NextRequest("http://localhost:6152/api/tasks/task-1/worktree", {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);
    const fallbackReadCall = vi.mocked(db.task.findFirst).mock.calls[1]?.[0];

    expect(response.status).toBe(200);
    expect(fallbackReadCall?.select).not.toHaveProperty("issueId");
    expect(data.task).toEqual(expect.objectContaining({
      id: "task-1",
      issue_id: null,
    }));
  });

  it("rejects cleanup when another task still shares the worktree root", async () => {
    vi.mocked(db.task.findFirst)
      .mockResolvedValueOnce({
        id: "task-1",
        projectId: "proj-1",
        title: "Worktree Task",
        taskType: "ai_task",
        status: "completed",
        agentHost: "daemon-1",
        executionHost: "daemon-1",
        backendType: "codex",
        sessionId: "session-1",
        sessionFilePath: "/tmp/session-1.jsonl",
        launchConfig: JSON.stringify({
          worktree: true,
          worktreeId: "task-1",
          worktreeBranch: "conductor/task/task-1",
          worktreeBaseRef: "main",
          projectRepoRoot: "/repo",
          projectWorkspacePath: "/repo/app",
          projectRelativePath: "app",
        }),
        metadata: null,
        createdAt: new Date("2026-04-03T12:00:00.000Z"),
        updatedAt: new Date("2026-04-03T12:01:00.000Z"),
        project: {
          daemonHost: "daemon-1",
        },
      } as any)
      .mockResolvedValueOnce({
        id: "task-2",
        projectId: "proj-1",
        title: "Worktree Successor",
        taskType: "ai_task",
        status: "running",
        agentHost: "daemon-1",
        executionHost: "daemon-1",
        backendType: "codex",
        sessionId: "session-2",
        sessionFilePath: "/tmp/session-2.jsonl",
        launchConfig: JSON.stringify({
          worktree: true,
          worktree_id: "task-1",
          worktree_branch: "conductor/task/task-1",
          worktree_base_ref: "main",
          project_repo_root: "/repo",
          project_workspace_path: "/repo/app",
          project_relative_path: "app",
        }),
        metadata: null,
        createdAt: new Date("2026-04-03T12:02:00.000Z"),
        updatedAt: new Date("2026-04-03T12:03:00.000Z"),
      } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([{
      id: "task-2",
      projectId: "proj-1",
      title: "Worktree Successor",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-1",
      executionHost: "daemon-1",
      backendType: "codex",
      sessionId: "session-2",
      sessionFilePath: "/tmp/session-2.jsonl",
      launchConfig: JSON.stringify({
        worktree: true,
        worktree_id: "task-1",
        worktree_branch: "conductor/task/task-1",
        worktree_base_ref: "main",
        project_repo_root: "/repo",
        project_workspace_path: "/repo/app",
        project_relative_path: "app",
      }),
      metadata: null,
      createdAt: new Date("2026-04-03T12:02:00.000Z"),
      updatedAt: new Date("2026-04-03T12:03:00.000Z"),
    } as any]);

    const response = await POST(
      new NextRequest("http://localhost:6152/api/tasks/task-1/worktree", {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe("Worktree is still shared with another task");
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
      }),
    );
    expect(db.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-1",
          id: { not: "task-1" },
        }),
      }),
    );
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("rejects cleanup while the task is still running", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      title: "Worktree Task",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-1",
      executionHost: "daemon-1",
      backendType: "codex",
      sessionId: "session-1",
      sessionFilePath: "/tmp/session-1.jsonl",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-1",
        worktreeBranch: "conductor/task/task-1",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo/app",
        projectRelativePath: "app",
      }),
      metadata: null,
      createdAt: new Date("2026-04-03T12:00:00.000Z"),
      updatedAt: new Date("2026-04-03T12:01:00.000Z"),
      project: {
        daemonHost: "daemon-1",
      },
    } as any);

    const response = await POST(
      new NextRequest("http://localhost:6152/api/tasks/task-1/worktree", {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe("Stop this task before removing its worktree");
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("routes manual-fire worktree cleanup to the original daemon from metadata", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      title: "Worktree Task",
      taskType: "ai_task",
      status: "completed",
      agentHost: "conductor-fire-debug-1",
      executionHost: null,
      backendType: "codex",
      sessionId: "session-1",
      sessionFilePath: "/tmp/session-1.jsonl",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-1",
        worktreeBranch: "conductor/task/task-1",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo/app",
        projectRelativePath: "app",
      }),
      metadata: JSON.stringify({ daemonName: "daemon-1" }),
      createdAt: new Date("2026-04-03T12:00:00.000Z"),
      updatedAt: new Date("2026-04-03T12:01:00.000Z"),
      project: {
        daemonHost: "daemon-1",
      },
    } as any);

    const response = await POST(
      new NextRequest("http://localhost:6152/api/tasks/task-1/worktree", {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.cleaned_at).toBe("2026-04-03T12:05:00.000Z");
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cleanup_task_worktree",
        agentHost: "daemon-1",
        taskId: "task-1",
      }),
      expect.any(Object),
    );
  });

  it("routes legacy manual-fire worktree cleanup to the project daemon when metadata is missing", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      title: "Worktree Task",
      taskType: "ai_task",
      status: "completed",
      agentHost: "conductor-fire-debug-1",
      executionHost: null,
      backendType: "codex",
      sessionId: "session-1",
      sessionFilePath: "/tmp/session-1.jsonl",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-1",
        worktreeBranch: "conductor/task/task-1",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo/app",
        projectRelativePath: "app",
      }),
      metadata: null,
      createdAt: new Date("2026-04-03T12:00:00.000Z"),
      updatedAt: new Date("2026-04-03T12:01:00.000Z"),
      project: {
        daemonHost: "daemon-1",
      },
    } as any);

    const response = await POST(
      new NextRequest("http://localhost:6152/api/tasks/task-1/worktree", {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.cleaned_at).toBe("2026-04-03T12:05:00.000Z");
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cleanup_task_worktree",
        agentHost: "daemon-1",
        taskId: "task-1",
      }),
      expect.any(Object),
    );
  });

  it("returns 504 when daemon cleanup confirmation times out", async () => {
    vi.mocked(realtimeHub.waitForTaskWorktreeCleanup).mockResolvedValueOnce(null);

    const response = await POST(
      new NextRequest("http://localhost:6152/api/tasks/task-1/worktree", {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(504);
    expect(data.error).toBe("Timed out waiting for daemon daemon-1 to confirm worktree cleanup");
    expect(realtimeHub.cancelTaskWorktreeCleanup).toHaveBeenCalledWith(expect.any(String));
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
      }),
    );
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledTimes(1);
    expect(db.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-1",
          id: { not: "task-1" },
        }),
      }),
    );
  });
});
