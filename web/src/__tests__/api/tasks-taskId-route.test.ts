import { describe, it, expect, vi, beforeEach } from "vitest";
import { DELETE, GET, PATCH } from "@/app/api/tasks/[taskId]/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return {
    ...mod,
    checkAndUpdateExpiredSubscription: vi.fn(),
  };
});

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    bindTaskToAgent: vi.fn(),
    broadcast: vi.fn(),
    sendToAgent: vi.fn(),
    sendToAgentHost: vi.fn(),
    getTaskAgentHost: vi.fn(),
    getAgentsForUser: vi.fn(),
    hasAgentHost: vi.fn(),
    getAgentDisconnectAt: vi.fn(),
    waitForAgentLogCollection: vi.fn(),
    cancelAgentLogCollection: vi.fn(),
    getTerminalLatencySample: vi.fn(),
    waitForTaskStopAck: vi.fn(),
    waitForTaskFinalStatus: vi.fn(),
    cancelTaskStopAck: vi.fn(),
    cancelTaskFinalStatus: vi.fn(),
    waitForTaskWorktreeCleanup: vi.fn(),
    cancelTaskWorktreeCleanup: vi.fn(),
    unbindTask: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn(),
  deliverAgentOutboxRow: vi.fn(),
  isMissingAgentOutboxTableError: (error: unknown) =>
    (error as any)?.code === "P2021" && String((error as any)?.message || "").includes("agent_outbox"),
  warnMissingAgentOutboxTable: vi.fn(),
}));

vi.mock("@/lib/tasks/task-file-storage", () => ({
  deleteTaskAttachmentDirectory: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    ptySession: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    agentOutbox: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    taskStatusEvent: {
      findFirst: vi.fn(),
    },
    taskDiagnosticsSnapshot: {
      create: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const {
  deliverAgentOutboxRow,
  enqueueAndAttemptAgentCommand,
} = await import("@/lib/realtime/agent-outbox");
const { deleteTaskAttachmentDirectory } = await import("@/lib/tasks/task-file-storage");

const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

describe("/api/tasks/[taskId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
      subscriptionStatus: "ACTIVE",
      subscriptionTier: "PLUS",
      subscriptionEndsAt: new Date(Date.now() + 86400000),
      trialEndsAt: null,
      lastPaymentAt: null,
    } as any);
    vi.mocked(realtimeHub.waitForTaskStopAck).mockResolvedValue(true);
    vi.mocked(realtimeHub.waitForTaskFinalStatus).mockResolvedValue("killed");
    vi.mocked(realtimeHub.cancelTaskStopAck).mockImplementation(() => true);
    vi.mocked(realtimeHub.cancelTaskFinalStatus).mockImplementation(() => 0);
    vi.mocked(realtimeHub.waitForTaskWorktreeCleanup).mockResolvedValue({
      request_id: "req-cleanup-1",
      task_id: "task-1",
      daemon_host: "daemon-a",
      worktree_branch: "abc123",
      removed_path: "/repo/.conductor/worktrees/task-1",
      cleaned: true,
      error: null,
      cleaned_at: "2026-03-05T12:00:02.000Z",
    });
    vi.mocked(realtimeHub.cancelTaskWorktreeCleanup).mockImplementation(() => {});
    vi.mocked(realtimeHub.sendToAgent).mockReturnValue(true);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.getAgentDisconnectAt).mockReturnValue(null);
    vi.mocked(realtimeHub.waitForAgentLogCollection).mockResolvedValue(null);
    vi.mocked(realtimeHub.cancelAgentLogCollection).mockImplementation(() => {});
    vi.mocked(realtimeHub.getTerminalLatencySample).mockReturnValue(null);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === "function"
        ? callback({
            task: db.task,
            ptySession: db.ptySession,
          })
        : callback,
    );
    vi.mocked(db.message.findMany).mockResolvedValue([]);
    vi.mocked(db.message.count).mockResolvedValue(0);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.taskStatusEvent.findFirst).mockResolvedValue(null);
    vi.mocked(db.ptySession.upsert).mockResolvedValue({
      id: "pty-1",
      taskId: "task-pty-1",
      state: "pending",
      entrypointType: "tool_preset",
      toolPreset: "codex",
      commandJson: null,
      cwd: "/tmp/worktree",
      envJson: null,
      shell: null,
      pid: null,
      cols: 120,
      rows: 40,
      lastOutputSeq: 0,
      startedAt: null,
      closedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as any);
    vi.mocked(db.ptySession.deleteMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(db.agentOutbox.findMany).mockResolvedValue([]);
    vi.mocked(db.agentOutbox.create).mockImplementation(async ({ data }: any) => ({
      id: "outbox-1",
      userId: data.userId,
      agentHost: data.agentHost,
      taskId: data.taskId,
      eventType: data.eventType,
      requestId: data.requestId,
      createdAt: new Date("2024-01-01T00:02:00.000Z"),
      payloadJson: data.payloadJson,
    }) as any);
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValue({
      requestId: "req-1",
      delivered: true,
    } as any);
    vi.mocked(deliverAgentOutboxRow).mockResolvedValue({
      delivered: true,
    });
    vi.mocked(db.taskDiagnosticsSnapshot.create).mockResolvedValue({
      id: "snapshot-1",
    } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === "function"
        ? callback({
            task: db.task,
            ptySession: db.ptySession,
            message: db.message,
            agentOutbox: db.agentOutbox,
          })
        : callback,
    );
  });

  it("should return 404 when task does not exist", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue(null);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-missing" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(404);
    expect(data.error).toBe("Not found");
    expect(db.message.deleteMany).not.toHaveBeenCalled();
    expect(db.task.delete).not.toHaveBeenCalled();
    expect(db.taskDiagnosticsSnapshot.create).not.toHaveBeenCalled();
    expect(realtimeHub.sendToAgent).not.toHaveBeenCalled();
  });

  it("should return pty task details with launch_config and pty_session", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-1",
      projectId: "proj-1",
      title: "Codex Terminal",
      taskType: "pty_task",
      status: "unknown",
      agentHost: "daemon-a",
      executionHost: null,
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/worktree",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      messages: [],
      ptySession: {
        id: "pty-1",
        taskId: "task-pty-1",
        state: "pending",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: "/tmp/worktree",
        envJson: null,
        shell: "/bin/zsh",
        pid: null,
        cols: 120,
        rows: 40,
        lastOutputSeq: 0,
        startedAt: null,
        closedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      },
    } as any);

    const request = createMockRequest({ method: "GET", token });
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-pty-1" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.task_type).toBe("pty_task");
    expect(data.launch_config).toEqual({
      entrypointType: "tool_preset",
      toolPreset: "codex",
      cwd: "/tmp/worktree",
    });
    expect(data.pty_session).toEqual(
      expect.objectContaining({
        id: "pty-1",
        task_id: "task-pty-1",
        state: "pending",
        tool_preset: "codex",
        cwd: "/tmp/worktree",
      }),
    );
  });

  it("recovers stale disconnected fire tasks when detail is fetched with recover_stale=1", async () => {
    const token = createTestToken("user-1");
    const now = Date.now();
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-fire-1",
      projectId: "proj-1",
      title: "Manual Fire Task",
      taskType: "ai_task",
      status: "running",
      agentHost: "conductor-fire-mac-123",
      executionHost: "conductor-fire-mac-123",
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: null,
      metadata: null,
      createdAt: new Date(now - 120_000),
      updatedAt: new Date(now - 120_000),
      ptySession: null,
    } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-fire-1",
      status: "killed",
      executionHost: null,
      updatedAt: new Date(now),
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.getAgentDisconnectAt).mockReturnValue(now - 120_000);

    const request = createMockRequest({
      method: "GET",
      token,
      url: "http://localhost:6152/api/tasks/task-fire-1?recover_stale=1",
    });
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-fire-1" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-fire-1" },
      data: { status: "killed", executionHost: null },
    });
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_status_update",
        payload: expect.objectContaining({
          task_id: "task-fire-1",
          status: "killed",
        }),
      }),
    );
    expect(data.status).toBe("killed");
    expect(data.execution_host).toBeNull();
  });

  it("falls back to legacy task detail reads when PTY schema columns are missing", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.launch_config` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-1",
        projectId: "proj-1",
        title: "Legacy Task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        metadata: JSON.stringify({ legacy: true }),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      } as any);
    const response = await GET(createMockRequest({ method: "GET", token }), {
      params: Promise.resolve({ taskId: "task-legacy-1" }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.task.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          projectId: true,
          title: true,
          status: true,
          agentHost: true,
          executionHost: true,
        }),
      }),
    );
    expect(data).toEqual(
      expect.objectContaining({
        id: "task-legacy-1",
        task_type: "ai_task",
        launch_config: null,
        pty_session: null,
      }),
    );
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("falls back to legacy task detail reads when issue relation columns are missing", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.issue_id` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-issue-1",
        projectId: "proj-1",
        title: "Legacy Issue Task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        metadata: JSON.stringify({ legacy: true }),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      } as any);

    const response = await GET(createMockRequest({ method: "GET", token }), {
      params: Promise.resolve({ taskId: "task-legacy-issue-1" }),
    });
    const data = await extractJson(response);
    const legacyFindFirstCall = vi.mocked(db.task.findFirst).mock.calls[1]?.[0];

    expect(response.status).toBe(200);
    expect(legacyFindFirstCall?.select).not.toHaveProperty("issueId");
    expect(data).toEqual(
      expect.objectContaining({
        id: "task-legacy-issue-1",
        issue_id: null,
        task_type: "ai_task",
        launch_config: null,
        pty_session: null,
      }),
    );
  });

  it("should send stop_task to agent and delete task", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      title: "Task 1",
      agentHost: "daemon-a",
      status: "running",
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 3 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-1" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-1" }) });

    expect(response.status).toBe(204);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-1", "daemon-a");
    expect(db.taskDiagnosticsSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        projectId: "proj-1",
        taskId: "task-1",
        trigger: "task_delete",
        payloadJson: expect.any(String),
      }),
    });
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        agentHost: "daemon-a",
        taskId: "task-1",
        eventType: "stop_task",
        envelope: expect.objectContaining({
          type: "stop_task",
          payload: expect.objectContaining({
            task_id: "task-1",
            project_id: "proj-1",
            reason: "deleted_by_user",
            request_id: expect.any(String),
          }),
        }),
      }),
      expect.any(Object),
    );
    expect(db.message.deleteMany).toHaveBeenCalledWith({
      where: { taskId: "task-1" },
    });
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-1" },
    });
    expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "proj-1", {
      type: "task_deleted",
      payload: {
        task_id: "task-1",
        project_id: "proj-1",
      },
    });
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-1");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-1");
  });

  it("should not collect remote fire logs while persisting delete diagnostics snapshot", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-fast-delete",
      projectId: "proj-1",
      title: "Task Fast Delete",
      agentHost: "daemon-a",
      executionHost: "conductor-fire-host-1",
      status: "running",
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
      metadata: JSON.stringify({ daemonName: "daemon-a" }),
    } as any);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-fast-delete" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-fast-delete" }) });

    expect(response.status).toBe(204);
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
    expect(realtimeHub.waitForAgentLogCollection).not.toHaveBeenCalled();
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-fast-delete");
  });

  it("should still delete task when agentHost is missing", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-2",
      projectId: "proj-1",
      title: "Task 2",
      agentHost: null,
      status: "completed",
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-2" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-2" }) });

    expect(response.status).toBe(204);
    expect(realtimeHub.bindTaskToAgent).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-2");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-2");
  });

  it("should delete task when agent explicitly nacks stop and no final status arrives", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-3",
      projectId: "proj-1",
      title: "Task 3",
      agentHost: "daemon-a",
      status: "running",
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(realtimeHub.waitForTaskStopAck).mockResolvedValue(false);
    vi.mocked(realtimeHub.waitForTaskFinalStatus).mockResolvedValue(null);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-3" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-3" }) });

    expect(response.status).toBe(204);
    expect(db.message.deleteMany).toHaveBeenCalledWith({
      where: { taskId: "task-3" },
    });
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-3" },
    });
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-3");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-3");
  });

  it("should still delete task when stop_task delivery fails", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-4",
      projectId: "proj-1",
      title: "Task 4",
      agentHost: "daemon-offline",
      status: "running",
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValue({
      requestId: "req-2",
      delivered: false,
    } as any);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-4" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-4" }) });

    expect(response.status).toBe(204);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalled();
    expect(realtimeHub.cancelTaskStopAck).toHaveBeenCalledWith(
      "task-4",
      expect.any(String),
    );
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-4" },
    });
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-4");
  });

  it("cleans up the isolated worktree before deleting the task", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-worktree-delete",
      projectId: "proj-1",
      title: "Task With Worktree",
      taskType: "ai_task",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      status: "running",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-worktree-delete",
        worktreeBranch: "abc123",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo",
        projectRelativePath: ".",
      }),
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-worktree-delete" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-worktree-delete" }) });

    expect(response.status).toBe(204);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId: "task-worktree-delete",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.any(Object),
    );
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          agentHost: "daemon-a",
          taskId: "task-worktree-delete",
          eventType: "cleanup_task_worktree",
        }),
      }),
    );
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-worktree-delete" },
    });
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-delete");
  });

  it("still deletes a stopped worktree task when its daemon is offline", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-worktree-offline",
      projectId: "proj-1",
      title: "Offline Worktree Task",
      taskType: "ai_task",
      agentHost: "daemon-offline",
      executionHost: "daemon-offline",
      status: "completed",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-worktree-offline",
        worktreeBranch: "fedcba",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo",
        projectRelativePath: ".",
      }),
      project: {
        daemonHost: "daemon-offline",
      },
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-worktree-offline" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-worktree-offline" }) });

    expect(response.status).toBe(204);
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          agentHost: "daemon-offline",
          taskId: "task-worktree-offline",
          eventType: "cleanup_task_worktree",
        }),
      }),
    );
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-worktree-offline" },
    });
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-offline");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-offline");
  });

  it("routes manual-fire worktree cleanup to the original daemon from metadata", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-worktree-manual-fire",
      projectId: "proj-1",
      title: "Manual Fire Worktree Task",
      taskType: "ai_task",
      agentHost: "conductor-fire-debug-1",
      executionHost: null,
      status: "completed",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-worktree-manual-fire",
        worktreeBranch: "fedcba",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo",
        projectRelativePath: ".",
      }),
      metadata: JSON.stringify({ daemonName: "daemon-a" }),
      project: {
        daemonHost: "daemon-a",
      },
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-worktree-manual-fire" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, {
      params: Promise.resolve({ taskId: "task-worktree-manual-fire" }),
    });

    expect(response.status).toBe(204);
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          agentHost: "daemon-a",
          taskId: "task-worktree-manual-fire",
          eventType: "cleanup_task_worktree",
        }),
      }),
    );
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-manual-fire");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-manual-fire");
  });

  it("routes legacy manual-fire worktree cleanup to the project daemon when metadata is missing", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-worktree-legacy-manual-fire",
      projectId: "proj-1",
      title: "Legacy Manual Fire Worktree Task",
      taskType: "ai_task",
      agentHost: "conductor-fire-debug-1",
      executionHost: null,
      status: "completed",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-worktree-legacy-manual-fire",
        worktreeBranch: "fedcba",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo",
        projectRelativePath: ".",
      }),
      metadata: null,
      project: {
        daemonHost: "daemon-a",
      },
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-worktree-legacy-manual-fire" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, {
      params: Promise.resolve({ taskId: "task-worktree-legacy-manual-fire" }),
    });

    expect(response.status).toBe(204);
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          agentHost: "daemon-a",
          taskId: "task-worktree-legacy-manual-fire",
          eventType: "cleanup_task_worktree",
        }),
      }),
    );
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-legacy-manual-fire");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-legacy-manual-fire");
  });

  it("still deletes a running worktree task when its daemon is offline", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-worktree-running-offline",
      projectId: "proj-1",
      title: "Offline Running Worktree Task",
      taskType: "ai_task",
      agentHost: "daemon-offline",
      executionHost: "daemon-offline",
      status: "running",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-worktree-running-offline",
        worktreeBranch: "fedcba",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo",
        projectRelativePath: ".",
      }),
      project: {
        daemonHost: "daemon-offline",
      },
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValue({
      requestId: "req-stop-offline",
      delivered: false,
    } as any);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-worktree-running-offline" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, {
      params: Promise.resolve({ taskId: "task-worktree-running-offline" }),
    });

    expect(response.status).toBe(204);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-worktree-running-offline",
        agentHost: "daemon-offline",
        eventType: "stop_task",
      }),
      expect.any(Object),
    );
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          agentHost: "daemon-offline",
          taskId: "task-worktree-running-offline",
          eventType: "cleanup_task_worktree",
        }),
      }),
    );
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-worktree-running-offline" },
    });
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-running-offline");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-running-offline");
  });

  it("skips worktree cleanup when a successor task still shares the root", async () => {
    const token = createTestToken("user-1");
    const sourceTask = {
      id: "task-worktree-source",
      projectId: "proj-1",
      title: "Shared Worktree Source",
      taskType: "ai_task",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      status: "running",
      launchConfig: JSON.stringify({
        worktree: true,
        worktreeId: "task-worktree-source",
        worktreeBranch: "abc123",
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo",
        projectRelativePath: ".",
      }),
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
      project: {
        daemonHost: "daemon-a",
      },
    } as any;
    const successorTask = {
      id: "task-worktree-successor",
      projectId: "proj-1",
      title: "Shared Worktree Successor",
      taskType: "ai_task",
      status: "init",
      agentHost: "daemon-a",
      executionHost: null,
      launchConfig: JSON.stringify({
        worktree: true,
        worktree_id: "task-worktree-source",
        worktree_branch: "abc123",
        worktree_base_ref: "main",
        project_repo_root: "/repo",
        project_workspace_path: "/repo",
        project_relative_path: ".",
      }),
      createdAt: new Date("2026-03-05T12:00:02.000Z"),
      updatedAt: new Date("2026-03-05T12:00:03.000Z"),
    } as any;
    vi.mocked(db.task.findFirst).mockImplementation(async ({ where }: any) => {
      if (where?.id === "task-worktree-source") {
        return sourceTask;
      }
      return null;
    });
    vi.mocked(db.task.findMany).mockResolvedValue([successorTask] as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-worktree-source" } as any);

    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, {
      params: Promise.resolve({ taskId: "task-worktree-source" }),
    });

    expect(response.status).toBe(204);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledTimes(1);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-worktree-source",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.any(Object),
    );
    expect(db.agentOutbox.create).not.toHaveBeenCalled();
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-worktree-source" },
    });
    expect(deleteTaskAttachmentDirectory).toHaveBeenCalledWith("task-worktree-source");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-worktree-source");
  });

  it("should persist task session fields via PATCH", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-5",
      projectId: "proj-1",
      title: "Task 5",
      status: "running",
      agentHost: "daemon-a",
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-5",
      projectId: "proj-1",
      title: "Task 5",
      status: "running",
      agentHost: "daemon-a",
      backendType: "codex",
      sessionId: "session-5",
      sessionFilePath: "/tmp/session-5.jsonl",
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
    } as any);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        backend_type: "codex",
        session_id: "session-5",
        session_file_path: "/tmp/session-5.jsonl",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-5" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-5" },
        data: expect.objectContaining({
          backendType: "codex",
          sessionId: "session-5",
          sessionFilePath: "/tmp/session-5.jsonl",
        }),
      }),
    );
    expect(data.backend_type).toBe("codex");
    expect(data.session_id).toBe("session-5");
    expect(data.session_file_path).toBe("/tmp/session-5.jsonl");
    expect(data.task_type).toBe("ai_task");
  });

  it("merges metadata when PATCH adds daemon binding for a manual fire task", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-5b",
      projectId: "proj-1",
      title: "Task 5b",
      status: "running",
      agentHost: "conductor-fire-host-1",
      backendType: "codex",
      sessionId: "session-5b",
      sessionFilePath: "/tmp/session-5b.jsonl",
      metadata: JSON.stringify({ initialContent: "hello", source: "manual-fire" }),
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-5b",
      projectId: "proj-1",
      title: "Task 5b",
      status: "running",
      agentHost: "conductor-fire-host-1",
      backendType: "codex",
      sessionId: "session-5b",
      sessionFilePath: "/tmp/session-5b.jsonl",
      metadata: JSON.stringify({
        initialContent: "hello",
        source: "manual-fire",
        daemonName: "daemon-a",
      }),
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
    } as any);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        metadata: {
          daemonName: "daemon-a",
        },
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-5b" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-5b" },
        data: expect.objectContaining({
          metadata: JSON.stringify({
            initialContent: "hello",
            source: "manual-fire",
            daemonName: "daemon-a",
          }),
        }),
      }),
    );
    expect(data.metadata).toEqual({
      initialContent: "hello",
      source: "manual-fire",
      daemonName: "daemon-a",
    });
  });

  it("sets a running task to killing and queues stop_task when PATCH requests killed", async () => {
    const token = createTestToken("user-1");
    const existingTask = {
      id: "task-stop-1",
      projectId: "proj-1",
      title: "Stop Me",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: "session-stop-1",
      sessionFilePath: "/tmp/session-stop-1.jsonl",
      launchConfig: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(existingTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingTask,
      ...data,
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    }) as any);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        status: "killed",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-stop-1" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-stop-1", "daemon-a");
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-stop-1" },
        data: expect.objectContaining({
          status: "killing",
          executionHost: "daemon-a",
        }),
      }),
    );
    const taskUpdateData = vi.mocked(db.task.update).mock.calls[0][0].data as any;
    const metadata = JSON.parse(taskUpdateData.metadata);
    const outboxData = vi.mocked(db.agentOutbox.create).mock.calls[0][0].data as any;
    const outboxPayload = JSON.parse(outboxData.payloadJson);
    expect(metadata).toEqual({
      killingStartedAt: expect.any(String),
      killingTimeoutMs: 60_000,
      killRequestId: outboxData.requestId,
    });
    expect(outboxData).toEqual(expect.objectContaining({
      userId: "user-1",
      agentHost: "daemon-a",
      taskId: "task-stop-1",
      eventType: "stop_task",
      status: "pending",
      attemptCount: 0,
      nextRetryAt: null,
    }));
    expect(outboxPayload).toEqual({
      type: "stop_task",
      payload: expect.objectContaining({
        task_id: "task-stop-1",
        project_id: "proj-1",
        request_id: outboxData.requestId,
        reason: "stopped_from_app",
      }),
    });
    expect(deliverAgentOutboxRow).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-stop-1",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.objectContaining({
        userId: "user-1",
        agentHost: "daemon-a",
      }),
    );
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    expect(realtimeHub.broadcast).toHaveBeenCalledWith("user-1", "proj-1", {
      type: "task_status_update",
      payload: {
        task_id: "task-stop-1",
        project_id: "proj-1",
        status: "killing",
        metadata,
        updated_at: "2024-01-01T00:02:00.000Z",
      },
    });
    expect(data.status).toBe("killing");
    expect(data.execution_host).toBe("daemon-a");
    expect(data.metadata).toEqual(metadata);
  });

  it("prefers a persisted conductor-fire host over a stale daemon binding when PATCH requests killed", async () => {
    const token = createTestToken("user-1");
    const existingTask = {
      id: "task-stop-fire-1",
      projectId: "proj-1",
      title: "Stop Me",
      taskType: "ai_task",
      status: "running",
      agentHost: "conductor-fire-unknown-host-21937",
      executionHost: "conductor-fire-unknown-host-21937",
      backendType: "codex",
      sessionId: "session-stop-fire-1",
      sessionFilePath: "/tmp/session-stop-fire-1.jsonl",
      launchConfig: null,
      metadata: JSON.stringify({ daemonName: "debug" }),
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    };
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("debug");
    vi.mocked(db.task.findFirst).mockResolvedValue(existingTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingTask,
      ...data,
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    }) as any);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        status: "killed",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-stop-fire-1" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith(
      "task-stop-fire-1",
      "conductor-fire-unknown-host-21937",
    );
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-stop-fire-1" },
        data: expect.objectContaining({
          status: "killing",
          executionHost: "conductor-fire-unknown-host-21937",
        }),
      }),
    );
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          agentHost: "conductor-fire-unknown-host-21937",
          taskId: "task-stop-fire-1",
          eventType: "stop_task",
        }),
      }),
    );
    expect(deliverAgentOutboxRow).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-stop-fire-1",
        agentHost: "conductor-fire-unknown-host-21937",
      }),
      expect.objectContaining({
        userId: "user-1",
        agentHost: "conductor-fire-unknown-host-21937",
      }),
    );
    expect(data.execution_host).toBe("conductor-fire-unknown-host-21937");
  });

  it("returns 409 when PATCH tries to kill a running task without any active daemon binding", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-stop-missing-host",
      projectId: "proj-1",
      title: "Stop Me",
      taskType: "ai_task",
      status: "running",
      agentHost: null,
      executionHost: null,
      backendType: "codex",
      sessionId: "session-stop-2",
      sessionFilePath: "/tmp/session-stop-2.jsonl",
      launchConfig: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        status: "killed",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-stop-missing-host" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe("Task missing active daemon binding");
    expect(db.task.update).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("keeps the task in killing when the queued stop_task cannot be delivered immediately", async () => {
    const token = createTestToken("user-1");
    const existingTask = {
      id: "task-stop-offline-host",
      projectId: "proj-1",
      title: "Stop Me",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: "session-stop-3",
      sessionFilePath: "/tmp/session-stop-3.jsonl",
      launchConfig: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(existingTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingTask,
      ...data,
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    }) as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-a");
    vi.mocked(deliverAgentOutboxRow).mockResolvedValue({
      delivered: false,
    });

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        status: "killed",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-stop-offline-host" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("killing");
    expect(db.agentOutbox.create).toHaveBeenCalled();
    expect(deliverAgentOutboxRow).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-stop-offline-host",
        agentHost: "daemon-a",
      }),
      expect.objectContaining({
        userId: "user-1",
        agentHost: "daemon-a",
      }),
    );
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("keeps an already killing task in killing without queuing a duplicate stop_task", async () => {
    const token = createTestToken("user-1");
    const existingMetadata = {
      killingStartedAt: "2024-01-01T00:01:00.000Z",
      killingTimeoutMs: 60_000,
      killRequestId: "req-existing",
    };
    const existingTask = {
      id: "task-stop-already-killing",
      projectId: "proj-1",
      title: "Stop Me",
      taskType: "ai_task",
      status: "killing",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: "session-stop-5",
      sessionFilePath: "/tmp/session-stop-5.jsonl",
      launchConfig: null,
      metadata: JSON.stringify(existingMetadata),
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(existingTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingTask,
      ...data,
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    }) as any);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        status: "killed",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-stop-already-killing" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-stop-already-killing" },
        data: expect.objectContaining({
          status: "killing",
          executionHost: "daemon-a",
          metadata: JSON.stringify(existingMetadata),
        }),
      }),
    );
    expect(db.agentOutbox.create).not.toHaveBeenCalled();
    expect(deliverAgentOutboxRow).not.toHaveBeenCalled();
    expect(data.status).toBe("killing");
    expect(data.metadata).toEqual(existingMetadata);
  });

  it("falls back to direct stop delivery when agent_outbox table is missing", async () => {
    const token = createTestToken("user-1");
    const existingTask = {
      id: "task-stop-fallback",
      projectId: "proj-1",
      title: "Stop Me",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: "session-stop-fallback",
      sessionFilePath: "/tmp/session-stop-fallback.jsonl",
      launchConfig: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(existingTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingTask,
      ...data,
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    }) as any);
    vi.mocked(db.agentOutbox.create).mockRejectedValueOnce(
      prismaError("P2021", 'The table `agent_outbox` does not exist in the current database.'),
    );

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        status: "killed",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-stop-fallback" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("killing");
    expect(deliverAgentOutboxRow).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-stop-fallback",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.objectContaining({
        agentHost: "daemon-a",
      }),
    );
  });

  it("returns 409 and rolls the task back when direct stop fallback cannot deliver", async () => {
    const token = createTestToken("user-1");
    const existingTask = {
      id: "task-stop-fallback-failed",
      projectId: "proj-1",
      title: "Stop Me",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: "session-stop-fallback-failed",
      sessionFilePath: "/tmp/session-stop-fallback-failed.jsonl",
      launchConfig: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(existingTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingTask,
      ...data,
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    }) as any);
    vi.mocked(db.agentOutbox.create).mockRejectedValueOnce(
      prismaError("P2021", 'The table `agent_outbox` does not exist in the current database.'),
    );
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValueOnce({
      requestId: "req-fallback-failed",
      delivered: false,
    } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: { status: "killed" },
      }),
      { params: Promise.resolve({ taskId: "task-stop-fallback-failed" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe("Failed to request task kill: task daemon daemon-a is offline");
    expect(deliverAgentOutboxRow).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-stop-fallback-failed",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.objectContaining({
        agentHost: "daemon-a",
      }),
    );
    expect(vi.mocked(db.task.update).mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        where: { id: "task-stop-fallback-failed" },
        data: expect.objectContaining({
          status: "running",
          executionHost: "daemon-a",
        }),
      }),
    );
    expect(realtimeHub.broadcast).not.toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_status_update",
        payload: expect.objectContaining({
          task_id: "task-stop-fallback-failed",
          status: "killing",
        }),
      }),
    );
  });

  it("moves init tasks into killing before stop dispatch", async () => {
    const token = createTestToken("user-1");
    const existingTask = {
      id: "task-stop-init",
      projectId: "proj-1",
      title: "Stop Me Early",
      taskType: "ai_task",
      status: "init",
      agentHost: "daemon-a",
      executionHost: null,
      backendType: "codex",
      sessionId: "session-stop-init",
      sessionFilePath: "/tmp/session-stop-init.jsonl",
      launchConfig: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      ptySession: null,
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(existingTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingTask,
      ...data,
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    }) as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: { status: "killed" },
      }),
      { params: Promise.resolve({ taskId: "task-stop-init" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("killing");
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-stop-init" },
        data: expect.objectContaining({
          status: "killing",
          executionHost: "daemon-a",
        }),
      }),
    );
    expect(db.agentOutbox.create).toHaveBeenCalled();
  });

  it("should promote a task to pty_task and upsert pty_session via PATCH", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-2",
      projectId: "proj-1",
      title: "Shell Task",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: null,
      sessionFilePath: null,
      launchConfig: null,
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-pty-1",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
    ]);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-pty-2",
      projectId: "proj-1",
      title: "Shell Task",
      taskType: "pty_task",
      status: "unknown",
      agentHost: "daemon-a",
      executionHost: null,
      backendType: "codex",
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "shell",
        shell: "/bin/zsh",
        cwd: "/tmp/worktree",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    } as any);
    vi.mocked(db.ptySession.upsert).mockResolvedValue({
      id: "pty-2",
      taskId: "task-pty-2",
      state: "pending",
      entrypointType: "shell",
      toolPreset: null,
      commandJson: null,
      cwd: "/tmp/worktree",
      envJson: null,
      shell: "/bin/zsh",
      pid: null,
      cols: null,
      rows: null,
      lastOutputSeq: 0,
      startedAt: null,
      closedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:02:00.000Z"),
    } as any);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        task_type: "pty_task",
        launch_config: {
          entrypointType: "shell",
          shell: "/bin/zsh",
          cwd: "/tmp/worktree",
        },
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-pty-2" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.waitForTaskStopAck).toHaveBeenCalledWith("task-pty-2", expect.any(String), 2500);
    expect(realtimeHub.waitForTaskFinalStatus).toHaveBeenCalledWith("task-pty-2", 5000);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-pty-2" },
        data: expect.objectContaining({
          taskType: "pty_task",
          status: "unknown",
          agentHost: "daemon-a",
          executionHost: null,
          launchConfig: JSON.stringify({
            entrypointType: "shell",
            shell: "/bin/zsh",
            cwd: "/tmp/worktree",
          }),
        }),
      }),
    );
    expect(db.ptySession.upsert).toHaveBeenCalledWith({
      where: { taskId: "task-pty-2" },
      update: expect.objectContaining({
        entrypointType: "shell",
        cwd: "/tmp/worktree",
        shell: "/bin/zsh",
      }),
      create: expect.objectContaining({
        taskId: "task-pty-2",
        entrypointType: "shell",
        cwd: "/tmp/worktree",
        shell: "/bin/zsh",
      }),
    });
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-pty-2", "daemon-a");
    expect(enqueueAndAttemptAgentCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: "user-1",
        agentHost: "daemon-a",
        taskId: "task-pty-2",
        eventType: "stop_task",
        envelope: expect.objectContaining({
          type: "stop_task",
          payload: expect.objectContaining({
            task_id: "task-pty-2",
            project_id: "proj-1",
            reason: "restart_pty_task",
            request_id: expect.any(String),
          }),
        }),
      }),
      expect.any(Object),
    );
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        agentHost: "daemon-a",
        taskId: "task-pty-2",
        eventType: "create_pty_task",
        envelope: {
          type: "create_pty_task",
          payload: expect.objectContaining({
            task_id: "task-pty-2",
            project_id: "proj-1",
            title: "Shell Task",
            pty_session_id: "pty-2",
            launch_config: {
              entrypointType: "shell",
              shell: "/bin/zsh",
              cwd: "/tmp/worktree",
            },
            request_id: expect.any(String),
          }),
        },
      }),
      expect.any(Object),
    );
    expect(
      vi.mocked(enqueueAndAttemptAgentCommand).mock.calls.map(([args]) => args.eventType),
    ).toEqual(["stop_task", "create_pty_task"]);
    expect(data.task_type).toBe("pty_task");
    expect(data.pty_session).toEqual(
      expect.objectContaining({
        id: "pty-2",
        task_id: "task-pty-2",
        state: "pending",
        cwd: "/tmp/worktree",
        shell: "/bin/zsh",
      }),
    );
  });

  it("falls back to legacy ai_task PATCH when PTY task columns are missing", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.task_type` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-patch-1",
        projectId: "proj-1",
        title: "Legacy Task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      } as any);
    vi.mocked(db.task.update)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.launch_config` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-patch-1",
        projectId: "proj-1",
        title: "Legacy Rename",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:02:00.000Z"),
      } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: { title: "Legacy Rename" },
      }),
      { params: Promise.resolve({ taskId: "task-legacy-patch-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.task.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.not.objectContaining({
          taskType: expect.anything(),
          launchConfig: expect.anything(),
        }),
        select: expect.objectContaining({
          id: true,
          projectId: true,
          title: true,
          status: true,
        }),
      }),
    );
    expect(data).toEqual(
      expect.objectContaining({
        id: "task-legacy-patch-1",
        title: "Legacy Rename",
        task_type: "ai_task",
        launch_config: null,
        pty_session: null,
      }),
    );
  });

  it("falls back to legacy ai_task kill PATCH when PTY task columns are missing", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.task_type` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-kill-1",
        projectId: "proj-1",
        title: "Legacy Task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      } as any);
    vi.mocked(db.task.update)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.launch_config` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-kill-1",
        projectId: "proj-1",
        title: "Legacy Task",
        status: "killing",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        metadata: JSON.stringify({
          killingStartedAt: "2024-01-01T00:02:00.000Z",
          killingTimeoutMs: 60_000,
          killRequestId: "req-legacy",
        }),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:02:00.000Z"),
      } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: { status: "killed" },
      }),
      { params: Promise.resolve({ taskId: "task-legacy-kill-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.task.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.not.objectContaining({
          taskType: expect.anything(),
          launchConfig: expect.anything(),
        }),
        select: expect.objectContaining({
          id: true,
          projectId: true,
          title: true,
          status: true,
        }),
      }),
    );
    expect(db.agentOutbox.create).toHaveBeenCalled();
    expect(data).toEqual(
      expect.objectContaining({
        id: "task-legacy-kill-1",
        status: "killing",
        task_type: "ai_task",
        launch_config: null,
        pty_session: null,
      }),
    );
  });

  it("falls back to legacy ai_task PATCH when issue relation columns are missing", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.issue_id` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-issue-patch-1",
        projectId: "proj-1",
        title: "Legacy Task",
        taskType: "ai_task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        ptySession: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:01:00.000Z"),
      } as any);
    vi.mocked(db.task.update)
      .mockRejectedValueOnce(
        prismaError("P2022", 'The column `tasks.issue_id` does not exist in the current database.'),
      )
      .mockResolvedValueOnce({
        id: "task-legacy-issue-patch-1",
        projectId: "proj-1",
        title: "Legacy Rename",
        taskType: "ai_task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:02:00.000Z"),
      } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: { title: "Legacy Rename" },
      }),
      { params: Promise.resolve({ taskId: "task-legacy-issue-patch-1" }) },
    );
    const data = await extractJson(response);
    const issueIdFallbackFindCall = vi.mocked(db.task.findFirst).mock.calls[1]?.[0];
    const issueIdFallbackUpdateCall = vi.mocked(db.task.update).mock.calls[1]?.[0];

    expect(response.status).toBe(200);
    // issueId-only fallback: PTY columns preserved, only issueId omitted
    expect(issueIdFallbackFindCall?.select).toBeDefined();
    expect(issueIdFallbackFindCall?.select).not.toHaveProperty("issueId");
    expect(issueIdFallbackFindCall?.select).toHaveProperty("taskType");
    expect(issueIdFallbackUpdateCall?.data).not.toHaveProperty("issueId");
    expect(data).toEqual(
      expect.objectContaining({
        id: "task-legacy-issue-patch-1",
        title: "Legacy Rename",
        issue_id: null,
        task_type: "ai_task",
      }),
    );
  });

  it("should preserve pty_session runtime state when patching an existing pty_task", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-running-1",
      projectId: "proj-1",
      title: "Existing Terminal",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/worktree",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:10:00.000Z"),
    } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-pty-running-1",
      projectId: "proj-1",
      title: "Renamed Terminal",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/worktree",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:11:00.000Z"),
    } as any);
    vi.mocked(db.ptySession.upsert).mockResolvedValue({
      id: "pty-running-1",
      taskId: "task-pty-running-1",
      state: "running",
      entrypointType: "tool_preset",
      toolPreset: "codex",
      commandJson: null,
      cwd: "/tmp/worktree",
      envJson: null,
      shell: "/bin/zsh",
      pid: 34567,
      cols: 120,
      rows: 40,
      lastOutputSeq: 12,
      startedAt: new Date("2024-01-01T00:05:00.000Z"),
      closedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:11:00.000Z"),
    } as any);

    const request = createMockRequest({
      method: "PATCH",
      token,
      body: {
        title: "Renamed Terminal",
      },
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: "task-pty-running-1" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.ptySession.upsert).toHaveBeenCalledWith({
      where: { taskId: "task-pty-running-1" },
      update: expect.not.objectContaining({
        state: "pending",
      }),
      create: expect.objectContaining({
        taskId: "task-pty-running-1",
        state: "pending",
      }),
    });
    expect(data.pty_session).toEqual(
      expect.objectContaining({
        id: "pty-running-1",
        task_id: "task-pty-running-1",
        state: "running",
        pid: 34567,
        last_output_seq: 12,
      }),
    );
  });

  it("re-dispatches create_pty_task when patching launch_config on an existing pty_task", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-running-2",
      projectId: "proj-1",
      title: "Existing Terminal",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/old",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:10:00.000Z"),
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-pty-1",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
    ]);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-pty-running-2",
      projectId: "proj-1",
      title: "Existing Terminal",
      taskType: "pty_task",
      status: "unknown",
      agentHost: "daemon-a",
      executionHost: null,
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/new",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:11:00.000Z"),
    } as any);
    vi.mocked(db.ptySession.upsert).mockResolvedValue({
      id: "pty-running-2",
      taskId: "task-pty-running-2",
      state: "pending",
      entrypointType: "tool_preset",
      toolPreset: "codex",
      commandJson: null,
      cwd: "/tmp/new",
      envJson: null,
      shell: null,
      pid: null,
      cols: null,
      rows: null,
      lastOutputSeq: 0,
      startedAt: null,
      closedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:11:00.000Z"),
    } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: {
          launch_config: {
            entrypointType: "tool_preset",
            toolPreset: "codex",
            cwd: "/tmp/new",
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-pty-running-2" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId: "task-pty-running-2",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.any(Object),
    );
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-pty-running-2" },
        data: expect.objectContaining({
          status: "unknown",
          executionHost: null,
        }),
      }),
    );
    expect(db.ptySession.upsert).toHaveBeenCalledWith({
      where: { taskId: "task-pty-running-2" },
      update: expect.objectContaining({
        state: "pending",
        cwd: "/tmp/new",
        pid: null,
        lastOutputSeq: 0,
      }),
      create: expect.objectContaining({
        taskId: "task-pty-running-2",
        state: "pending",
        cwd: "/tmp/new",
      }),
    });
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-pty-running-2",
        eventType: "create_pty_task",
      }),
      expect.any(Object),
    );
    expect(data).toEqual(
      expect.objectContaining({
        task_type: "pty_task",
        pty_session: expect.objectContaining({
          state: "pending",
          cwd: "/tmp/new",
        }),
      }),
    );
  });

  it("stops the old host before re-dispatching when PATCH switches PTY agent_host", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-switch-1",
      projectId: "proj-1",
      title: "Switch Terminal",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/worktree",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:10:00.000Z"),
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-a",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
      {
        id: "agent-b",
        host: "daemon-b",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
    ]);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-pty-switch-1",
      projectId: "proj-1",
      title: "Switch Terminal",
      taskType: "pty_task",
      status: "unknown",
      agentHost: "daemon-b",
      executionHost: null,
      backendType: "codex",
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/worktree-b",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:11:00.000Z"),
    } as any);
    vi.mocked(db.ptySession.upsert).mockResolvedValue({
      id: "pty-switch-1",
      taskId: "task-pty-switch-1",
      state: "pending",
      entrypointType: "tool_preset",
      toolPreset: "codex",
      commandJson: null,
      cwd: "/tmp/worktree-b",
      envJson: null,
      shell: null,
      pid: null,
      cols: null,
      rows: null,
      lastOutputSeq: 0,
      startedAt: null,
      closedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:11:00.000Z"),
    } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: {
          agent_host: "daemon-b",
          launch_config: {
            entrypointType: "tool_preset",
            toolPreset: "codex",
            cwd: "/tmp/worktree-b",
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-pty-switch-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId: "task-pty-switch-1",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.any(Object),
    );
    expect(enqueueAndAttemptAgentCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        taskId: "task-pty-switch-1",
        agentHost: "daemon-b",
        eventType: "create_pty_task",
      }),
      expect.any(Object),
    );
    expect(data).toEqual(
      expect.objectContaining({
        agent_host: "daemon-b",
        task_type: "pty_task",
      }),
    );
  });

  it("rejects invalid PTY terminal dimensions in PATCH before writing task state", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-invalid-dims-1",
      projectId: "proj-1",
      title: "Invalid Dims",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:10:00.000Z"),
    } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: {
          launch_config: {
            cols: "abc",
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-pty-invalid-dims-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toContain("cols");
    expect(db.task.update).not.toHaveBeenCalled();
    expect(db.ptySession.upsert).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("does not stop or re-dispatch PTY when the PATCH transaction fails before relaunch", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-tx-1",
      projectId: "proj-1",
      title: "Broken Patch",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/old",
      }),
      metadata: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:10:00.000Z"),
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-pty-1",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
    ]);
    vi.mocked(db.$transaction).mockImplementationOnce(async (callback: any) =>
      callback({
        task: {
          update: vi.fn().mockResolvedValue({
            id: "task-pty-tx-1",
            projectId: "proj-1",
            title: "Broken Patch",
            taskType: "pty_task",
            status: "unknown",
            agentHost: "daemon-a",
            executionHost: null,
            backendType: null,
            sessionId: null,
            sessionFilePath: null,
            launchConfig: JSON.stringify({
              entrypointType: "tool_preset",
              toolPreset: "codex",
              cwd: "/tmp/new",
            }),
            metadata: null,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-01T00:11:00.000Z"),
          }),
        },
        ptySession: {
          upsert: vi.fn().mockRejectedValue(new Error("transient-pty-upsert-failure")),
        },
      }),
    );

    await expect(
      PATCH(
        createMockRequest({
          method: "PATCH",
          token,
          body: {
            launch_config: {
              entrypointType: "tool_preset",
              toolPreset: "codex",
              cwd: "/tmp/new",
            },
          },
        }),
        { params: Promise.resolve({ taskId: "task-pty-tx-1" }) },
      ),
    ).rejects.toThrow("transient-pty-upsert-failure");

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("rolls back PTY PATCH DB state when stop_task fails after the relaunch transaction", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-stop-fail-1",
      projectId: "proj-1",
      title: "Rollback Terminal",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/old",
      }),
      metadata: JSON.stringify({ before: true }),
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:10:00.000Z"),
      ptySession: {
        id: "pty-stop-fail-1",
        taskId: "task-pty-stop-fail-1",
        state: "running",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: "/tmp/old",
        envJson: null,
        shell: "/bin/zsh",
        pid: 4321,
        cols: 120,
        rows: 40,
        lastOutputSeq: 12,
        startedAt: new Date("2024-01-01T00:05:00.000Z"),
        closedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:10:00.000Z"),
      },
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-a",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
      {
        id: "agent-b",
        host: "daemon-b",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
    ]);
    vi.mocked(db.task.update)
      .mockResolvedValueOnce({
        id: "task-pty-stop-fail-1",
        projectId: "proj-1",
        title: "Rollback Terminal",
        taskType: "pty_task",
        status: "unknown",
        agentHost: "daemon-b",
        executionHost: null,
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        launchConfig: JSON.stringify({
          entrypointType: "tool_preset",
          toolPreset: "codex",
          cwd: "/tmp/new",
        }),
        metadata: JSON.stringify({ before: true }),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:11:00.000Z"),
      } as any)
      .mockResolvedValueOnce({
        id: "task-pty-stop-fail-1",
        projectId: "proj-1",
        title: "Rollback Terminal",
        taskType: "pty_task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        launchConfig: JSON.stringify({
          entrypointType: "tool_preset",
          toolPreset: "codex",
          cwd: "/tmp/old",
        }),
        metadata: JSON.stringify({ before: true }),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:12:00.000Z"),
      } as any);
    vi.mocked(db.ptySession.upsert)
      .mockResolvedValueOnce({
        id: "pty-stop-fail-1",
        taskId: "task-pty-stop-fail-1",
        state: "pending",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: "/tmp/new",
        envJson: null,
        shell: null,
        pid: null,
        cols: 140,
        rows: 50,
        lastOutputSeq: 0,
        startedAt: null,
        closedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:11:00.000Z"),
      } as any)
      .mockResolvedValueOnce({
        id: "pty-stop-fail-1",
        taskId: "task-pty-stop-fail-1",
        state: "running",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: "/tmp/old",
        envJson: null,
        shell: "/bin/zsh",
        pid: 4321,
        cols: 120,
        rows: 40,
        lastOutputSeq: 12,
        startedAt: new Date("2024-01-01T00:05:00.000Z"),
        closedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:12:00.000Z"),
      } as any);
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValueOnce({
      requestId: "req-stop-fail-1",
      delivered: false,
    } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.cancelTaskStopAck).mockImplementation(() => true);
    vi.mocked(realtimeHub.cancelTaskFinalStatus).mockImplementation(() => 0);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: {
          agent_host: "daemon-b",
          launch_config: {
            entrypointType: "tool_preset",
            toolPreset: "codex",
            cwd: "/tmp/new",
            cols: 140,
            rows: 50,
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-pty-stop-fail-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("Failed to stop");
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.task.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "task-pty-stop-fail-1" },
        data: expect.objectContaining({
          agentHost: "daemon-b",
          executionHost: null,
          status: "unknown",
        }),
      }),
    );
    expect(db.task.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "task-pty-stop-fail-1" },
        data: expect.objectContaining({
          agentHost: "daemon-a",
          executionHost: "daemon-a",
          status: "running",
          launchConfig: JSON.stringify({
            entrypointType: "tool_preset",
            toolPreset: "codex",
            cwd: "/tmp/old",
          }),
        }),
      }),
    );
    expect(db.ptySession.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { taskId: "task-pty-stop-fail-1" },
        update: expect.objectContaining({
          state: "running",
          cwd: "/tmp/old",
          pid: 4321,
          lastOutputSeq: 12,
        }),
      }),
    );
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-pty-stop-fail-1", "daemon-a");
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledTimes(1);
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-pty-stop-fail-1");
    expect(realtimeHub.cancelTaskStopAck).toHaveBeenCalledWith(
      "task-pty-stop-fail-1",
      expect.any(String),
    );
    expect(realtimeHub.cancelTaskFinalStatus).toHaveBeenCalledWith("task-pty-stop-fail-1");
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledTimes(1);
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-pty-stop-fail-1",
        agentHost: "daemon-a",
        eventType: "stop_task",
      }),
      expect.any(Object),
    );
  });

  it("rolls back PTY PATCH DB state and clears stop waiters when stop_task throws after the relaunch transaction", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-stop-throw-1",
      projectId: "proj-1",
      title: "Rollback Terminal",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-a",
      executionHost: "daemon-a",
      backendType: "codex",
      sessionId: null,
      sessionFilePath: null,
      launchConfig: JSON.stringify({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/old",
      }),
      metadata: JSON.stringify({ before: true }),
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:10:00.000Z"),
      ptySession: {
        id: "pty-stop-throw-1",
        taskId: "task-pty-stop-throw-1",
        state: "running",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: "/tmp/old",
        envJson: null,
        shell: "/bin/zsh",
        pid: 4321,
        cols: 120,
        rows: 40,
        lastOutputSeq: 12,
        startedAt: new Date("2024-01-01T00:05:00.000Z"),
        closedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:10:00.000Z"),
      },
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-a",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
      {
        id: "agent-b",
        host: "daemon-b",
        supportedBackends: ["codex"],
        capabilities: ["pty_task"],
      },
    ]);
    vi.mocked(db.task.update)
      .mockResolvedValueOnce({
        id: "task-pty-stop-throw-1",
        projectId: "proj-1",
        title: "Rollback Terminal",
        taskType: "pty_task",
        status: "unknown",
        agentHost: "daemon-b",
        executionHost: null,
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        launchConfig: JSON.stringify({
          entrypointType: "tool_preset",
          toolPreset: "codex",
          cwd: "/tmp/new",
        }),
        metadata: JSON.stringify({ before: true }),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:11:00.000Z"),
      } as any)
      .mockResolvedValueOnce({
        id: "task-pty-stop-throw-1",
        projectId: "proj-1",
        title: "Rollback Terminal",
        taskType: "pty_task",
        status: "running",
        agentHost: "daemon-a",
        executionHost: "daemon-a",
        backendType: "codex",
        sessionId: null,
        sessionFilePath: null,
        launchConfig: JSON.stringify({
          entrypointType: "tool_preset",
          toolPreset: "codex",
          cwd: "/tmp/old",
        }),
        metadata: JSON.stringify({ before: true }),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:12:00.000Z"),
      } as any);
    vi.mocked(db.ptySession.upsert)
      .mockResolvedValueOnce({
        id: "pty-stop-throw-1",
        taskId: "task-pty-stop-throw-1",
        state: "pending",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: "/tmp/new",
        envJson: null,
        shell: null,
        pid: null,
        cols: 140,
        rows: 50,
        lastOutputSeq: 0,
        startedAt: null,
        closedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:11:00.000Z"),
      } as any)
      .mockResolvedValueOnce({
        id: "pty-stop-throw-1",
        taskId: "task-pty-stop-throw-1",
        state: "running",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: "/tmp/old",
        envJson: null,
        shell: "/bin/zsh",
        pid: 4321,
        cols: 120,
        rows: 40,
        lastOutputSeq: 12,
        startedAt: new Date("2024-01-01T00:05:00.000Z"),
        closedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:12:00.000Z"),
      } as any);
    vi.mocked(enqueueAndAttemptAgentCommand).mockRejectedValueOnce(new Error("socket closed"));
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.cancelTaskStopAck).mockImplementation(() => true);
    vi.mocked(realtimeHub.cancelTaskFinalStatus).mockImplementation(() => 0);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token,
        body: {
          agent_host: "daemon-b",
          launch_config: {
            entrypointType: "tool_preset",
            toolPreset: "codex",
            cwd: "/tmp/new",
            cols: 140,
            rows: 50,
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-pty-stop-throw-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("Failed to stop");
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-pty-stop-throw-1", "daemon-a");
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-pty-stop-throw-1");
    expect(realtimeHub.cancelTaskStopAck).toHaveBeenCalledWith(
      "task-pty-stop-throw-1",
      expect.any(String),
    );
    expect(realtimeHub.cancelTaskFinalStatus).toHaveBeenCalledWith("task-pty-stop-throw-1");
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledTimes(1);
  });

  it("should still delete task when diagnostics snapshot creation fails", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-6",
      projectId: "proj-1",
      title: "Task 6",
      agentHost: null,
      executionHost: null,
      status: "running",
      createdAt: new Date("2026-03-05T12:00:00.000Z"),
      updatedAt: new Date("2026-03-05T12:00:01.000Z"),
    } as any);
    vi.mocked(db.taskDiagnosticsSnapshot.create).mockRejectedValue(new Error("snapshot-write-failed"));
    vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.delete).mockResolvedValue({ id: "task-6" } as any);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = createMockRequest({ method: "DELETE", token });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: "task-6" }) });
    consoleErrorSpy.mockRestore();

    expect(response.status).toBe(204);
    expect(db.task.delete).toHaveBeenCalledWith({
      where: { id: "task-6" },
    });
    expect(realtimeHub.unbindTask).toHaveBeenCalledWith("task-6");
  });
});
