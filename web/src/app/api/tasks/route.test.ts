import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "@/app/api/tasks/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

const countActiveScheduledMessagesForTasksMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    bindTaskToAgent: vi.fn(),
    sendToAgent: vi.fn(),
    sendToAgentHost: vi.fn(),
    getTaskAgentHost: vi.fn(),
    getAgentsForUser: vi.fn().mockReturnValue([]),
    hasAgentHost: vi.fn().mockReturnValue(false),
    getAgentDisconnectAt: vi.fn().mockReturnValue(null),
    unbindTask: vi.fn(),
    notifyTaskStatus: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn(),
  enqueueAgentCommand: vi.fn(),
  isMissingAgentOutboxTableError: () => false,
}));

vi.mock("@/lib/tasks/scheduled-messages", () => ({
  countActiveScheduledMessagesForTasks: countActiveScheduledMessagesForTasksMock,
}));

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return {
    ...mod,
    checkAndUpdateExpiredSubscription: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    ptySession: {
      create: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
    defaultProject: {
      findUnique: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    attachedTerminal: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");

const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

let defaultProjectId: string | null = null;
const setDefaultProjectId = (projectId: string | null) => {
  defaultProjectId = projectId;
  vi.mocked(db.defaultProject.findUnique).mockImplementation(async () =>
    defaultProjectId ? ({ projectId: defaultProjectId } as any) : null,
  );
};

describe("/api/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultProjectId = null;
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === "function"
        ? callback({
            task: db.task,
            ptySession: db.ptySession,
            message: db.message,
          })
        : Array.isArray(callback)
          ? Promise.all(callback)
          : callback,
    );
    vi.mocked(db.task.findMany).mockResolvedValue([]);
    countActiveScheduledMessagesForTasksMock.mockResolvedValue(new Map());
    vi.mocked(db.attachedTerminal.findMany).mockResolvedValue([]);
    vi.mocked(db.attachedTerminal.findUnique).mockResolvedValue(null);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
    vi.mocked(realtimeHub.getAgentDisconnectAt).mockReturnValue(null);
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValue({
      requestId: "req-1",
      delivered: false,
    } as any);
    vi.mocked(db.ptySession.create).mockResolvedValue({
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
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as any);
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
    vi.mocked(db.message.findMany).mockResolvedValue([]);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-updated",
      updatedAt: new Date("2024-01-03T00:00:00.000Z"),
    } as any);
    setDefaultProjectId(null);
  });

  describe("GET", () => {
    it("should return 401 when not authenticated", async () => {
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

      const request = createMockRequest({});
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return user tasks when authenticated", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockTasks = [
        {
          id: "task-1",
          projectId: "proj-1",
          title: "Task 1",
          status: "pending",
          agentHost: null,
          executionHost: null,
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          metadata: JSON.stringify({ key: "value" }),
          ptySession: {
            id: "pty-1",
            taskId: "task-1",
            state: "exited",
            entrypointType: "shell",
            toolPreset: null,
            commandJson: null,
            cwd: "/tmp/worktree",
            envJson: null,
            shell: "/bin/zsh",
            pid: 1234,
            cols: 120,
            rows: 40,
            lastOutputSeq: 9,
            startedAt: new Date("2024-01-01T00:00:00.000Z"),
            closedAt: new Date("2024-01-01T00:05:00.000Z"),
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-01T00:05:00.000Z"),
          },
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ];

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue(mockTasks as any);
      countActiveScheduledMessagesForTasksMock.mockResolvedValue(new Map([["task-1", 2]]));
      vi.mocked(db.message.findMany).mockResolvedValue([
        {
          id: "msg-2",
          taskId: "task-1",
          role: "assistant",
          content: "Assistant reply",
          createdAt: new Date("2024-01-02T00:00:00.000Z"),
        },
        {
          id: "msg-1",
          taskId: "task-1",
          role: "user",
          content: "User prompt",
          createdAt: new Date("2024-01-01T23:59:00.000Z"),
        },
      ] as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({ token });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("task-1");
      expect(data[0].title).toBe("Task 1");
      expect(data[0].task_type).toBe("ai_task");
      expect(data[0].launch_config).toBeNull();
      expect(data[0].last_user_message).toBe("User prompt");
      expect(data[0].last_assistant_message).toBe("Assistant reply");
      expect(data[0].active_scheduled_message_count).toBe(2);
      expect(data[0].activeScheduledMessageCount).toBe(2);
      expect(countActiveScheduledMessagesForTasksMock).toHaveBeenCalledWith({
        userId: "user-1",
        taskIds: ["task-1"],
      });
      expect(data[0].pty_session).toEqual(
        expect.objectContaining({
          id: "pty-1",
          state: "exited",
          pid: 1234,
          last_output_seq: 9,
        }),
      );
    });

    it("sorts refreshed task lists by latest activity so mobile returns keep new-message tasks on top", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue([
        {
          id: "task-older-created",
          projectId: "proj-1",
          title: "Older but recently active",
          status: "running",
          agentHost: null,
          executionHost: null,
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          metadata: null,
          ptySession: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          updatedAt: new Date("2024-01-01T00:10:00.000Z"),
        },
        {
          id: "task-newer-created",
          projectId: "proj-1",
          title: "Newer but idle",
          status: "running",
          agentHost: null,
          executionHost: null,
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          metadata: null,
          ptySession: null,
          createdAt: new Date("2024-01-01T00:05:00.000Z"),
          updatedAt: new Date("2024-01-01T00:05:00.000Z"),
        },
      ] as any);

      const token = createTestToken("user-1");
      const response = await GET(createMockRequest({ token }));
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.map((task: { id: string }) => task.id)).toEqual([
        "task-older-created",
        "task-newer-created",
      ]);
    });

    it("should filter by project_id when provided", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue([]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        token,
        url: "http://localhost:6152/api/tasks?project_id=proj-1",
      });
      await GET(request);

      expect(db.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: "proj-1",
          }),
        })
      );
    });

    it("filters by project_ids when listing tasks across a merged cross-daemon group", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue([]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        token,
        url: "http://localhost:6152/api/tasks?project_ids=proj-a,proj-b",
      });
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(db.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: { in: ["proj-a", "proj-b"] },
          }),
        }),
      );
    });

    it("rejects requests that combine project_id and project_ids", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue([]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        token,
        url: "http://localhost:6152/api/tasks?project_id=proj-a&project_ids=proj-b",
      });
      const response = await GET(request);

      expect(response.status).toBe(400);
      const body = await extractJson(response);
      expect(body.error).toBe("Specify either project_id or project_ids, not both");
      expect(db.task.findMany).not.toHaveBeenCalled();
    });

    it("falls back to legacy task reads when PTY schema columns are missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany)
        .mockRejectedValueOnce(
          prismaError("P2022", 'The column `tasks.task_type` does not exist in the current database.'),
        )
        .mockResolvedValueOnce([
          {
            id: "task-legacy-1",
            projectId: "proj-1",
            title: "Legacy Task",
            status: "running",
            agentHost: "daemon-a",
            executionHost: "daemon-a",
            backendType: "codex",
            sessionId: null,
            sessionFilePath: null,
            metadata: JSON.stringify({ source: "legacy" }),
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-01T00:01:00.000Z"),
          },
        ] as any);

      const token = createTestToken("user-1");
      const response = await GET(createMockRequest({ token }));
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.task.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          select: expect.objectContaining({
            id: true,
            projectId: true,
            title: true,
            status: true,
            agentHost: true,
            executionHost: true,
            backendType: true,
            sessionId: true,
            sessionFilePath: true,
            metadata: true,
          }),
        }),
      );
      expect(data).toEqual([
        expect.objectContaining({
          id: "task-legacy-1",
          task_type: "ai_task",
          launch_config: null,
          pty_session: null,
        }),
      ]);
    });

    it("falls back to legacy task reads when issue relation columns are missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany)
        .mockRejectedValueOnce(
          prismaError("P2022", 'The column `tasks.issue_id` does not exist in the current database.'),
        )
        .mockResolvedValueOnce([
          {
            id: "task-legacy-issue-1",
            projectId: "proj-1",
            title: "Legacy Issue Task",
            status: "running",
            agentHost: "daemon-a",
            executionHost: "daemon-a",
            backendType: "codex",
            sessionId: null,
            sessionFilePath: null,
            metadata: JSON.stringify({ source: "legacy" }),
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-01T00:01:00.000Z"),
          },
        ] as any);

      const response = await GET(createMockRequest({ token: createTestToken("user-1") }));
      const data = await extractJson(response);
      const legacyFindManyCall = vi.mocked(db.task.findMany).mock.calls[1]?.[0];

      expect(response.status).toBe(200);
      expect(legacyFindManyCall?.select).not.toHaveProperty("issueId");
      expect(data).toEqual([
        expect.objectContaining({
          id: "task-legacy-issue-1",
          issue_id: null,
          task_type: "ai_task",
          launch_config: null,
          pty_session: null,
        }),
      ]);
    });

    it("should allow access even when subscription status is expired", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.user.findUnique).mockResolvedValue({
        id: "user-1",
        subscriptionStatus: "EXPIRED",
        subscriptionTier: "FREE",
        subscriptionEndsAt: null,
        trialEndsAt: new Date(Date.now() - 1000),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({ token });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data).toEqual([]);
    });

    it("should recover stale disconnected conductor-fire tasks when recover_stale=1", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const now = Date.now();
      const mockTasks = [
        {
          id: "task-fire-1",
          projectId: "proj-1",
          title: "Manual Fire Task",
          status: "running",
          agentHost: "conductor-fire-mac-123",
          executionHost: "conductor-fire-mac-123",
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          metadata: null,
          createdAt: new Date(now - 120_000),
          updatedAt: new Date(now - 120_000),
        },
      ];

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue(mockTasks as any);
      vi.mocked(db.task.update).mockResolvedValue({
        ...mockTasks[0],
        status: "killed",
      } as any);
      vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
      vi.mocked(realtimeHub.getAgentDisconnectAt).mockReturnValue(now - 120_000);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        token,
        url: "http://localhost:6152/api/tasks?recover_stale=1",
      });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      // RFC 0029: defensive stale-recovery kills now carry the discriminator
      // so the restart route can choose reclaim vs. spawn.
      expect(db.task.update).toHaveBeenCalledWith({
        where: { id: "task-fire-1" },
        data: expect.objectContaining({
          status: "killed",
          executionHost: null,
          killedReason: "daemon_disconnected",
          killedAt: expect.any(Date),
        }),
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
        })
      );
      expect(data[0].status).toBe("killed");
    });

    it("should recover stale disconnected daemon tasks when recover_stale=1", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const now = Date.now();
      const mockTasks = [
        {
          id: "task-daemon-1",
          projectId: "proj-1",
          title: "Daemon Task",
          status: "running",
          agentHost: "daemon-a",
          executionHost: "daemon-a",
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          metadata: null,
          createdAt: new Date(now - 180_000),
          updatedAt: new Date(now - 180_000),
        },
      ];

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue(mockTasks as any);
      vi.mocked(db.task.update).mockResolvedValue({
        ...mockTasks[0],
        status: "killed",
      } as any);
      vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
      vi.mocked(realtimeHub.getAgentDisconnectAt).mockReturnValue(now - 180_000);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        token,
        url: "http://localhost:6152/api/tasks?recover_stale=1",
      });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      // RFC 0029: daemon-side stale recovery tags killed_reason so reclaim
      // is available next time around.
      expect(db.task.update).toHaveBeenCalledWith({
        where: { id: "task-daemon-1" },
        data: expect.objectContaining({
          status: "killed",
          executionHost: null,
          killedReason: "daemon_disconnected",
          killedAt: expect.any(Date),
        }),
      });
      expect(realtimeHub.broadcast).toHaveBeenCalledWith(
        "user-1",
        "proj-1",
        expect.objectContaining({
          type: "task_status_update",
          payload: expect.objectContaining({
            task_id: "task-daemon-1",
            status: "killed",
          }),
        })
      );
      expect(data[0].status).toBe("killed");
    });

    it("should not kill a still-running task when the Web instance has no disconnectAt record (split-brain protection)", async () => {
      // Reproduces the regression where recover_stale=1 marked a healthy
      // Codex/fire session as `killed` purely because this Web instance had
      // no in-memory record of the agent — e.g. fresh Web boot, websocket
      // dropout, or another Web instance is the one actually holding the
      // agent socket. The agent's task.updatedAt is ancient relative to the
      // current Web process, so without the boot-time floor we would falsely
      // declare the task offline-since-updatedAt and kill it.
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const now = Date.now();
      const mockTasks = [
        {
          id: "task-fire-split-brain",
          projectId: "proj-1",
          title: "Healthy fire task on another instance",
          status: "running",
          agentHost: "conductor-fire-mac-789",
          executionHost: "conductor-fire-mac-789",
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          metadata: null,
          // Ancient timestamps — pretend the task has been running for hours.
          createdAt: new Date(now - 6 * 60 * 60_000),
          updatedAt: new Date(now - 6 * 60 * 60_000),
        },
      ];

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue(mockTasks as any);
      // No connection on this instance, and no disconnectAt either — exactly
      // the state right after a Web restart.
      vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
      vi.mocked(realtimeHub.getAgentDisconnectAt).mockReturnValue(null);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        token,
        url: "http://localhost:6152/api/tasks?recover_stale=1",
      });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.task.update).not.toHaveBeenCalled();
      expect(data[0].status).toBe("running");
    });

    it("should not recover a task when execution host is connected fire", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const now = Date.now();
      const mockTasks = [
        {
          id: "task-fire-owned",
          projectId: "proj-1",
          title: "Fire Owned Task",
          status: "running",
          agentHost: "daemon-a",
          executionHost: "conductor-fire-host-1",
          metadata: null,
          createdAt: new Date(now - 300_000),
          updatedAt: new Date(now - 300_000),
        },
      ];

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.task.findMany).mockResolvedValue(mockTasks as any);
      vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-host-1");
      vi.mocked(realtimeHub.hasAgentHost).mockImplementation((host: string) => host === "conductor-fire-host-1");
      vi.mocked(realtimeHub.getAgentDisconnectAt).mockImplementation((host: string) =>
        host === "daemon-a" ? now - 300_000 : null,
      );

      const token = createTestToken("user-1");
      const request = createMockRequest({
        token,
        url: "http://localhost:6152/api/tasks?recover_stale=1",
      });
      const response = await GET(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.task.update).not.toHaveBeenCalled();
      expect(data[0].status).toBe("running");
    });
  });

  describe("POST", () => {
    it("should return 401 when not authenticated", async () => {
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

      const request = createMockRequest({
        method: "POST",
        body: { project_id: "proj-1", title: "New Task" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
    });

    it("should return 400 when project_id is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { title: "New Task" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("project_id required");
    });

    it("should return 404 when project not found", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue(null);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { project_id: "proj-1", title: "New Task" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(404);
      expect(data.error).toBe("Project not found");
    });

    it("should reject when project daemon conflicts with requested agent_host", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-bound",
        name: "Bound Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/repo/bound",
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: "agent-1", host: "daemon-1", supportedBackends: ["codex"], capabilities: [] },
      ] as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-bound",
          title: "New Task",
          agent_host: "daemon-2",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toContain("Project daemon");
      expect(db.task.create).not.toHaveBeenCalled();
    });

    it("should reject when project daemon is offline", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-bound",
        name: "Bound Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/repo/bound",
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([] as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-bound",
          title: "New Task",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toContain("offline");
      expect(db.task.create).not.toHaveBeenCalled();
    });

    it("should allow free user to create app task when only manual fire task is active", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-mixed", name: "Project Mixed", userId: "user-1" };
      const mockTask = {
        id: "task-free-app",
        projectId: "proj-mixed",
        title: "Allowed App Task",
        status: "pending",
        agentHost: "daemon-1",
        metadata: null,
        createdAt: new Date("2024-01-07"),
        updatedAt: new Date("2024-01-07"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      vi.mocked(db.user.findUnique).mockResolvedValue({
        id: "user-1",
        subscriptionTier: "FREE",
      } as any);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.findMany).mockResolvedValue([
        { status: "running", agentHost: "conductor-fire-mac-1" },
      ] as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-mixed",
          title: "Allowed App Task",
          agentHost: "daemon-1",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("task-free-app");
      expect(data.agent_host).toBe("daemon-1");
      expect(db.task.create).toHaveBeenCalled();
    });

    it("should create task when authenticated and project exists", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-1", name: "Project 1", userId: "user-1" };
      const mockTask = {
        id: "task-2",
        projectId: "proj-1",
        title: "New Task",
        status: "pending",
        agentHost: null,
        executionHost: null,
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);
      vi.mocked(db.message.create).mockResolvedValue({
        id: "msg-1",
        createdAt: new Date("2024-01-03"),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { project_id: "proj-1", title: "New Task" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("task-2");
      expect(data.title).toBe("New Task");
    });

    it("should default manual fire tasks to running when created by a fire host", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-fire", name: "Project Fire", userId: "user-1" };
      const mockTask = {
        id: "task-fire-running",
        projectId: "proj-fire",
        title: "Manual Fire Task",
        status: "running",
        agentHost: "conductor-fire-host-1",
        executionHost: "conductor-fire-host-1",
        metadata: null,
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-fire",
          title: "Manual Fire Task",
          agent_host: "conductor-fire-host-1",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.status).toBe("running");
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "running",
            agentHost: "conductor-fire-host-1",
            executionHost: "conductor-fire-host-1",
          }),
        })
      );
    });

    it("should allow fire host to create tasks on daemon-bound projects", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-daemon",
        name: "Daemon Project",
        userId: "user-1",
        daemonHost: "my-daemon",
        workspacePath: "/home/user/project",
      };
      const mockTask = {
        id: "task-fire-daemon",
        projectId: "proj-daemon",
        title: "Fire on Daemon Project",
        status: "running",
        agentHost: "conductor-fire-host-1",
        executionHost: "conductor-fire-host-1",
        metadata: null,
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-02"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: "agent-fire", host: "conductor-fire-host-1", supportedBackends: ["codex"], capabilities: [] },
      ] as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-daemon",
          title: "Fire on Daemon Project",
          agent_host: "conductor-fire-host-1",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.status).toBe("running");
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentHost: "conductor-fire-host-1",
            executionHost: "conductor-fire-host-1",
          }),
        })
      );
      // Fire host should NOT trigger create_task outbox command
      expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
      // But the task should still be bound in realtime hub
      expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-fire-daemon", "conductor-fire-host-1");
    });

    it("should accept camelCase fields and map metadata", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-2", name: "Project 2", userId: "user-1" };
      const mockTask = {
        id: "task-3",
        projectId: "proj-2",
        title: "Camel Task",
        status: "pending",
        agentHost: "daemon-1",
        executionHost: "daemon-1",
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        metadata: JSON.stringify({ backendType: "codex", initialContent: "hello" }),
        createdAt: new Date("2024-01-03"),
        updatedAt: new Date("2024-01-03"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          projectId: "proj-2",
          title: "Camel Task",
          agentHost: "daemon-1",
          backendType: "codex",
          initialContent: "hello",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.id).toBe("task-3");
      expect(data.agent_host).toBe("daemon-1");
      expect(db.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task-3" },
          data: expect.objectContaining({
            updatedAt: expect.any(Date),
          }),
        }),
      );
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId: "proj-2",
            agentHost: "daemon-1",
          }),
        })
      );
    });

    it("should persist task session binding fields when provided", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-session", name: "Project Session", userId: "user-1" };
      const mockTask = {
        id: "task-session-1",
        projectId: "proj-session",
        title: "Session Task",
        status: "pending",
        taskType: "ai_task",
        agentHost: "daemon-1",
        executionHost: "daemon-1",
        backendType: "codex",
        sessionId: "session-1",
        sessionFilePath: "/tmp/session-1.jsonl",
        launchConfig: JSON.stringify({
          backendType: "codex",
          resumeSessionId: "session-1",
          sessionFilePath: "/tmp/session-1.jsonl",
        }),
        metadata: null,
        createdAt: new Date("2024-01-08"),
        updatedAt: new Date("2024-01-08"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-session",
          title: "Session Task",
          backend_type: "codex",
          session_id: "session-1",
          session_file_path: "/tmp/session-1.jsonl",
          agent_host: "daemon-1",
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            backendType: "codex",
            sessionId: "session-1",
            sessionFilePath: "/tmp/session-1.jsonl",
          }),
        })
      );
      expect(data.backend_type).toBe("codex");
      expect(data.session_id).toBe("session-1");
      expect(data.session_file_path).toBe("/tmp/session-1.jsonl");
      expect(data.task_type).toBe("ai_task");
      expect(data.launch_config).toEqual({
        backendType: "codex",
        resumeSessionId: "session-1",
        sessionFilePath: "/tmp/session-1.jsonl",
      });
    });

    it("forces ai task launch config to use the project workspace and worktree branch", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-bound",
        name: "Bound Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/repo/bound",
        worktreeBranch: "main",
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(null);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-1",
          host: "daemon-1",
          supportedBackends: ["codex"],
          capabilities: [],
        },
      ]);
      vi.mocked(db.task.create).mockImplementation(async ({ data }: any) => ({
        id: "task-bound-1",
        projectId: data.projectId,
        title: data.title,
        status: data.status,
        agentHost: data.agentHost,
        executionHost: data.executionHost,
        backendType: data.backendType,
        sessionId: data.sessionId,
        sessionFilePath: data.sessionFilePath,
        launchConfig: data.launchConfig,
        metadata: data.metadata,
        createdAt: new Date("2024-01-03"),
        updatedAt: new Date("2024-01-03"),
      }) as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-bound",
          title: "Bound Task",
          backend_type: "codex",
          agent_host: "daemon-1",
          launch_config: {
            cwd: "/tmp/override",
            worktreeBranch: "feature-branch",
            backendType: "codex",
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(JSON.parse(vi.mocked(db.task.create).mock.calls.at(-1)?.[0].data.launchConfig as string)).toEqual({
        backendType: "codex",
        cwd: "/repo/bound",
        worktreeBranch: "main",
      });
      expect(data.launch_config).toEqual({
        backendType: "codex",
        cwd: "/repo/bound",
        worktreeBranch: "main",
      });
    });

    it("builds task worktree launch config for git-backed ai tasks and forwards it to the daemon", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const createdAt = new Date("2024-01-03T00:00:00.000Z");
      const mockProject = {
        id: "proj-git",
        name: "Git Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/repo/packages/app",
        repoRoot: "/repo",
        worktreeBranch: "main",
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(null);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-1",
          host: "daemon-1",
          supportedBackends: ["codex"],
          capabilities: [],
        },
      ]);
      vi.mocked(db.task.create).mockImplementation(async ({ data }: any) => ({
        id: data.id,
        projectId: data.projectId,
        title: data.title,
        status: data.status,
        agentHost: data.agentHost,
        executionHost: data.executionHost,
        backendType: data.backendType,
        sessionId: data.sessionId,
        sessionFilePath: data.sessionFilePath,
        launchConfig: data.launchConfig,
        metadata: data.metadata,
        createdAt,
        updatedAt: createdAt,
      }) as any);

      const response = await POST(
        createMockRequest({
          method: "POST",
          token: createTestToken("user-1"),
          body: {
            project_id: "proj-git",
            title: "Isolated Task",
            backend_type: "codex",
            launch_config: {
              worktree: true,
            },
          },
        }),
      );
      const data = await extractJson(response);
      const createdLaunchConfig = JSON.parse(
        vi.mocked(db.task.create).mock.calls.at(-1)?.[0].data.launchConfig as string,
      );

      expect(response.status).toBe(200);
      expect(createdLaunchConfig).toEqual({
        backendType: "codex",
        worktree: true,
        worktreeId: expect.any(String),
        worktreeBranch: expect.stringMatching(/^[0-9a-f]{6}$/),
        worktreeBaseRef: "main",
        projectRepoRoot: "/repo",
        projectWorkspacePath: "/repo/packages/app",
        projectRelativePath: "packages/app",
      });
      expect(data.id).toBe(createdLaunchConfig.worktreeId);
      expect(data.launch_config).toEqual(createdLaunchConfig);
      expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "create_task",
          taskId: createdLaunchConfig.worktreeId,
          envelope: {
            type: "create_task",
            payload: expect.objectContaining({
              task_id: createdLaunchConfig.worktreeId,
              launch_config: createdLaunchConfig,
            }),
          },
        }),
        expect.any(Object),
      );
    });

    it("rejects worktree requests for projects without git metadata", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-no-git",
        name: "Plain Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/repo/plain",
        repoRoot: null,
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(null);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-1",
          host: "daemon-1",
          supportedBackends: ["codex"],
          capabilities: [],
        },
      ]);

      const response = await POST(
        createMockRequest({
          method: "POST",
          token: createTestToken("user-1"),
          body: {
            project_id: "proj-no-git",
            title: "Bad Worktree",
            launch_config: {
              worktree: true,
            },
          },
        }),
      );
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toBe("Worktree requires a git-backed bound project");
      expect(db.task.create).not.toHaveBeenCalled();
      expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    });

    it("rejects worktree requests for PTY tasks", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = {
        id: "proj-git-pty",
        name: "Git Project",
        userId: "user-1",
        daemonHost: "daemon-1",
        workspacePath: "/repo/app",
        repoRoot: "/repo",
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(null);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-1",
          host: "daemon-1",
          supportedBackends: ["codex"],
          capabilities: ["pty_task"],
        },
      ]);

      const response = await POST(
        createMockRequest({
          method: "POST",
          token: createTestToken("user-1"),
          body: {
            project_id: "proj-git-pty",
            title: "Bad PTY Worktree",
            task_type: "pty_task",
            agent_host: "daemon-1",
            launch_config: {
              entrypointType: "shell",
              worktree: true,
            },
          },
        }),
      );
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe("PTY task does not support worktree");
      expect(db.task.create).not.toHaveBeenCalled();
      expect(db.ptySession.create).not.toHaveBeenCalled();
      expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    });

    it("falls back to legacy ai_task creation when PTY task columns are missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-legacy", name: "Legacy Project", userId: "user-1" };
      const createdAt = new Date("2024-01-11T00:00:00.000Z");

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create)
        .mockRejectedValueOnce(
          prismaError("P2022", 'The column `tasks.launch_config` does not exist in the current database.'),
        )
        .mockResolvedValueOnce({
          id: "task-legacy-create-1",
          projectId: "proj-legacy",
          title: "Legacy Create",
          status: "unknown",
          agentHost: "daemon-a",
          executionHost: "daemon-a",
          backendType: "codex",
          sessionId: "session-legacy",
          sessionFilePath: "/tmp/session-legacy.jsonl",
          metadata: JSON.stringify({ initialContent: "hi" }),
          createdAt,
          updatedAt: createdAt,
        } as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-1",
          host: "daemon-a",
          supportedBackends: ["codex"],
          capabilities: [],
        },
      ]);
      vi.mocked(db.message.create).mockResolvedValue({
        id: "message-1",
        createdAt,
      } as any);

      const response = await POST(
        createMockRequest({
          method: "POST",
          token: createTestToken("user-1"),
          body: {
            project_id: "proj-legacy",
            title: "Legacy Create",
            backend_type: "codex",
            session_id: "session-legacy",
            session_file_path: "/tmp/session-legacy.jsonl",
            initial_content: "hi",
            agent_host: "daemon-a",
          },
        }),
      );
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.task.create).toHaveBeenNthCalledWith(
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
            agentHost: true,
            executionHost: true,
          }),
        }),
      );
      expect(data).toEqual(
        expect.objectContaining({
          id: "task-legacy-create-1",
          task_type: "ai_task",
          launch_config: null,
          pty_session: null,
        }),
      );
      expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "create_task",
        }),
        expect.any(Object),
      );
    });

    it("falls back to legacy ai_task creation when issue relation columns are missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-legacy", name: "Legacy Project", userId: "user-1" };
      const createdAt = new Date("2024-01-12T00:00:00.000Z");

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create)
        .mockRejectedValueOnce(
          prismaError("P2022", 'The column `tasks.issue_id` does not exist in the current database.'),
        )
        .mockResolvedValueOnce({
          id: "task-legacy-issue-create-1",
          projectId: "proj-legacy",
          title: "Legacy Issue Create",
          taskType: "ai_task",
          status: "unknown",
          agentHost: "daemon-a",
          executionHost: "daemon-a",
          backendType: "codex",
          sessionId: "session-legacy",
          sessionFilePath: "/tmp/session-legacy.jsonl",
          launchConfig: JSON.stringify({ backendType: "codex", initialContent: "hi", cwd: null }),
          metadata: JSON.stringify({ initialContent: "hi" }),
          createdAt,
          updatedAt: createdAt,
        } as any);
      vi.mocked(db.task.update)
        .mockRejectedValueOnce(
          prismaError("P2022", 'The column `tasks.issue_id` does not exist in the current database.'),
        )
        .mockResolvedValueOnce({
          updatedAt: createdAt,
        } as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-1",
          host: "daemon-a",
          supportedBackends: ["codex"],
          capabilities: [],
        },
      ]);
      vi.mocked(db.message.create).mockResolvedValue({
        id: "message-issue-1",
        createdAt,
      } as any);

      const response = await POST(
        createMockRequest({
          method: "POST",
          token: createTestToken("user-1"),
          body: {
            project_id: "proj-legacy",
            title: "Legacy Issue Create",
            backend_type: "codex",
            session_id: "session-legacy",
            session_file_path: "/tmp/session-legacy.jsonl",
            initial_content: "hi",
            agent_host: "daemon-a",
          },
        }),
      );
      const data = await extractJson(response);
      const issueIdFallbackCreateCall = vi.mocked(db.task.create).mock.calls[1]?.[0];

      expect(response.status).toBe(200);
      // issueId-only fallback: PTY columns preserved, only issueId removed
      expect(issueIdFallbackCreateCall?.data).not.toHaveProperty("issueId");
      expect(issueIdFallbackCreateCall?.data).toHaveProperty("taskType", "ai_task");
      expect(issueIdFallbackCreateCall?.data).toHaveProperty("launchConfig");
      expect(data).toEqual(
        expect.objectContaining({
          id: "task-legacy-issue-create-1",
          issue_id: null,
          task_type: "ai_task",
        }),
      );
    });

    it("rejects invalid PTY terminal dimensions before creating the task", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-pty", name: "Project Pty", userId: "user-1" };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-pty-1",
          host: "daemon-1",
          supportedBackends: ["codex"],
          capabilities: ["pty_task"],
        },
      ]);

      const response = await POST(
        createMockRequest({
          method: "POST",
          token: createTestToken("user-1"),
          body: {
            project_id: "proj-pty",
            title: "Bad PTY",
            task_type: "pty_task",
            agent_host: "daemon-1",
            launch_config: {
              entrypointType: "tool_preset",
              toolPreset: "codex",
              cols: "-1",
            },
          },
        }),
      );
      const data = await extractJson(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain("cols");
      expect(db.task.create).not.toHaveBeenCalled();
      expect(db.ptySession.create).not.toHaveBeenCalled();
      expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    });

    it("uses a transaction for PTY task creation so ptySession failures do not dispatch partial state", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-pty", name: "Project Pty", userId: "user-1" };
      const createdAt = new Date("2024-01-09T00:00:00.000Z");

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-pty-1",
          host: "daemon-1",
          supportedBackends: ["codex"],
          capabilities: ["pty_task"],
        },
      ]);
      vi.mocked(db.$transaction).mockImplementationOnce(async (callback: any) =>
        callback({
          task: {
            create: vi.fn().mockResolvedValue({
              id: "task-pty-tx-1",
              projectId: "proj-pty",
              title: "Broken PTY",
              taskType: "pty_task",
              status: "unknown",
              agentHost: "daemon-1",
              executionHost: null,
              backendType: null,
              sessionId: null,
              sessionFilePath: null,
              launchConfig: JSON.stringify({
                entrypointType: "tool_preset",
                toolPreset: "codex",
              }),
              metadata: null,
              createdAt,
              updatedAt: createdAt,
            }),
          },
          ptySession: {
            create: vi.fn().mockRejectedValue(new Error("transient-pty-write-failure")),
          },
        }),
      );

      await expect(
        POST(
          createMockRequest({
            method: "POST",
            token: createTestToken("user-1"),
            body: {
              project_id: "proj-pty",
              title: "Broken PTY",
              task_type: "pty_task",
              agent_host: "daemon-1",
              launch_config: {
                entrypointType: "tool_preset",
                toolPreset: "codex",
              },
            },
          }),
        ),
      ).rejects.toThrow("transient-pty-write-failure");

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(realtimeHub.bindTaskToAgent).not.toHaveBeenCalled();
      expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    });

    it("should enqueue create_pty_task for pty_task records", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-pty", name: "Project Pty", userId: "user-1" };
      const createdAt = new Date("2024-01-09T00:00:00.000Z");
      const mockTask = {
        id: "task-pty-1",
        projectId: "proj-pty",
        title: "Codex Terminal",
        taskType: "pty_task",
        status: "unknown",
        agentHost: "daemon-1",
        executionHost: null,
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: JSON.stringify({
          entrypointType: "tool_preset",
          toolPreset: "codex",
          cwd: "/tmp/worktree",
          cols: 120,
          rows: 40,
        }),
        metadata: null,
        createdAt,
        updatedAt: createdAt,
      };
      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-pty-1",
          host: "daemon-1",
          supportedBackends: ["codex"],
          capabilities: ["pty_task"],
        },
      ]);
      vi.mocked(db.ptySession.create).mockResolvedValue({
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
        createdAt,
        updatedAt: createdAt,
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-pty",
          title: "Codex Terminal",
          task_type: "pty_task",
          agent_host: "daemon-1",
          launch_config: {
            entrypointType: "tool_preset",
            toolPreset: "codex",
            cwd: "/tmp/worktree",
            cols: 120,
            rows: 40,
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            taskType: "pty_task",
            executionHost: null,
            launchConfig: JSON.stringify({
              entrypointType: "tool_preset",
              toolPreset: "codex",
              cwd: "/tmp/worktree",
              cols: 120,
              rows: 40,
            }),
          }),
        }),
      );
      expect(db.ptySession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: "task-pty-1",
          state: "pending",
          entrypointType: "tool_preset",
          toolPreset: "codex",
          cwd: "/tmp/worktree",
          cols: 120,
          rows: 40,
        }),
      });
      expect(db.message.create).not.toHaveBeenCalled();
      expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-pty-1", "daemon-1");
      expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          agentHost: "daemon-1",
          taskId: "task-pty-1",
          eventType: "create_pty_task",
          envelope: {
            type: "create_pty_task",
            payload: expect.objectContaining({
              task_id: "task-pty-1",
              project_id: "proj-pty",
              title: "Codex Terminal",
              pty_session_id: "pty-1",
              launch_config: {
                entrypointType: "tool_preset",
                toolPreset: "codex",
                cwd: "/tmp/worktree",
                cols: 120,
                rows: 40,
              },
              request_id: expect.any(String),
            }),
          },
        }),
        expect.any(Object),
      );
      expect(data.task_type).toBe("pty_task");
      expect(data.launch_config).toEqual({
        entrypointType: "tool_preset",
        toolPreset: "codex",
        cwd: "/tmp/worktree",
        cols: 120,
        rows: 40,
      });
      expect(data.pty_session).toEqual(
        expect.objectContaining({
          id: "pty-1",
          task_id: "task-pty-1",
          state: "pending",
          tool_preset: "codex",
          cwd: "/tmp/worktree",
          cols: 120,
          rows: 40,
        }),
      );
    });

    it("should reject pty_task when requested agent is not PTY-capable", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-pty", name: "Project Pty", userId: "user-1" };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-old",
          host: "daemon-old",
          supportedBackends: ["codex"],
          capabilities: [],
        },
      ]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-pty",
          title: "Unsupported Terminal",
          task_type: "pty_task",
          agent_host: "daemon-old",
          launch_config: {
            entrypointType: "tool_preset",
            toolPreset: "codex",
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toContain("does not support");
      expect(db.task.create).not.toHaveBeenCalled();
      expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    });

    it("should auto-select a PTY-capable daemon and ignore fire or old daemon hosts", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-pty-auto", name: "Project Pty Auto", userId: "user-1" };
      const createdAt = new Date("2024-01-10T00:00:00.000Z");
      const mockTask = {
        id: "task-pty-auto-1",
        projectId: "proj-pty-auto",
        title: "Auto PTY",
        taskType: "pty_task",
        status: "unknown",
        agentHost: "daemon-new",
        executionHost: null,
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: JSON.stringify({
          entrypointType: "tool_preset",
          toolPreset: "codex",
        }),
        metadata: null,
        createdAt,
        updatedAt: createdAt,
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);
      vi.mocked(db.ptySession.create).mockResolvedValue({
        id: "pty-auto-1",
        taskId: "task-pty-auto-1",
        state: "pending",
        entrypointType: "tool_preset",
        toolPreset: "codex",
        commandJson: null,
        cwd: null,
        envJson: null,
        shell: null,
        pid: null,
        cols: null,
        rows: null,
        lastOutputSeq: 0,
        startedAt: null,
        closedAt: null,
        createdAt,
        updatedAt: createdAt,
      } as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        {
          id: "agent-fire",
          host: "conductor-fire-worker",
          supportedBackends: ["codex"],
          capabilities: ["pty_task"],
        },
        {
          id: "agent-old",
          host: "daemon-old",
          supportedBackends: ["codex"],
          capabilities: [],
        },
        {
          id: "agent-new",
          host: "daemon-new",
          supportedBackends: ["codex"],
          capabilities: ["pty_task"],
        },
      ]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: {
          project_id: "proj-pty-auto",
          title: "Auto PTY",
          task_type: "pty_task",
          launch_config: {
            entrypointType: "tool_preset",
            toolPreset: "codex",
          },
        },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.agent_host).toBe("daemon-new");
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentHost: "daemon-new",
          }),
        }),
      );
    });

    it("should auto-assign an available daemon when agent_host is missing", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-3", name: "Project 3", userId: "user-1" };
      const mockTask = {
        id: "task-4",
        projectId: "proj-3",
        title: "Auto Task",
        status: "pending",
        agentHost: "daemon-1",
        executionHost: "daemon-1",
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        createdAt: new Date("2024-01-04"),
        updatedAt: new Date("2024-01-04"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: "agent-1", host: "daemon-1", supportedBackends: [], capabilities: [] },
      ]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { project_id: "proj-3", title: "Auto Task" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.agent_host).toBe("daemon-1");
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentHost: "daemon-1",
          }),
        })
      );
    });

    it("should prefer daemon host over conductor-fire host for auto-assignment", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-4", name: "Project 4", userId: "user-1" };
      const mockTask = {
        id: "task-5",
        projectId: "proj-4",
        title: "Daemon Preferred Task",
        status: "pending",
        agentHost: "daemon-1",
        executionHost: "daemon-1",
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        createdAt: new Date("2024-01-05"),
        updatedAt: new Date("2024-01-05"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: "agent-fire", host: "conductor-fire-unknown-host-123", supportedBackends: [], capabilities: [] },
        { id: "agent-daemon", host: "daemon-1", supportedBackends: ["codex", "claude"], capabilities: [] },
      ]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { project_id: "proj-4", title: "Daemon Preferred Task" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.agent_host).toBe("daemon-1");
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentHost: "daemon-1",
          }),
        })
      );
    });

    it("should prefer daemon supporting requested backend type", async () => {
      const mockUser = { id: "user-1", email: "test@example.com", phone: null };
      const mockProject = { id: "proj-5", name: "Project 5", userId: "user-1" };
      const mockTask = {
        id: "task-6",
        projectId: "proj-5",
        title: "Backend Matched Task",
        status: "pending",
        agentHost: "daemon-claude",
        executionHost: "daemon-claude",
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        metadata: JSON.stringify({ backendType: "claude" }),
        createdAt: new Date("2024-01-06"),
        updatedAt: new Date("2024-01-06"),
      };

      vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
      setDefaultProjectId(mockProject.id);
      vi.mocked(db.project.findFirst).mockResolvedValue(mockProject as any);
      vi.mocked(db.task.create).mockResolvedValue(mockTask as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: "agent-codex", host: "daemon-codex", supportedBackends: ["codex"], capabilities: [] },
        { id: "agent-claude", host: "daemon-claude", supportedBackends: ["claude"], capabilities: [] },
      ]);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        token,
        body: { project_id: "proj-5", title: "Backend Matched Task", backendType: "claude" },
      });
      const response = await POST(request);
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.agent_host).toBe("daemon-claude");
      expect(db.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentHost: "daemon-claude",
          }),
        })
      );
    });
  });
});
