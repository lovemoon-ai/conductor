import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST, DELETE } from "@/app/api/tasks/[taskId]/terminal/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    bindTaskToAgent: vi.fn(),
    sendToAgent: vi.fn(),
    sendToAgentHost: vi.fn(),
    getTaskAgentHost: vi.fn(),
    getAgentsForUser: vi.fn().mockReturnValue([
      {
        id: "agent-1",
        host: "host.local",
        supportedBackends: ["claude"],
        capabilities: ["pty_task", "ai_task"],
      },
    ]),
    hasAgentHost: vi.fn().mockReturnValue(true),
    getAgentDisconnectAt: vi.fn().mockReturnValue(null),
    unbindTask: vi.fn(),
    notifyTaskStatus: vi.fn(),
    waitForTaskStopAck: vi.fn().mockResolvedValue(true),
    cancelTaskStopAck: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn().mockResolvedValue({
    requestId: "req-1",
    delivered: true,
  }),
}));

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return {
    ...mod,
    checkAndUpdateExpiredSubscription: vi.fn(),
  };
});

vi.mock("@/lib/tasks/task-file-storage", () => ({
  deleteTaskAttachmentDirectory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    ptySession: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    attachedTerminal: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    message: {
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");

const ACTIVE_USER = {
  id: "user-1",
  email: "test@example.com",
  phone: null,
  subscriptionStatus: "ACTIVE",
  subscriptionTier: "PLUS",
  subscriptionEndsAt: new Date(Date.now() + 86400000),
  trialEndsAt: null,
  lastPaymentAt: null,
};

const aiTaskFixture = {
  id: "ai-1",
  projectId: "proj-1",
  title: "Build feature",
  taskType: "ai_task",
  agentHost: "host.local",
  launchConfig: JSON.stringify({ cwd: "/repo" }),
  project: {
    daemonHost: "host.local",
    workspacePath: "/repo",
  },
};

const ptyTaskFixture = {
  id: "pty-attached-1",
  projectId: "proj-1",
  title: "Build feature · terminal",
  taskType: "pty_task",
  status: "init",
  agentHost: "host.local",
  executionHost: null,
  backendType: null,
  sessionId: null,
  sessionFilePath: null,
  launchConfig: JSON.stringify({ cwd: "/repo" }),
  metadata: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

const ptySessionFixture = {
  id: "pty-session-1",
  taskId: "pty-attached-1",
  state: "pending",
  entrypointType: null,
  toolPreset: null,
  commandJson: null,
  cwd: "/repo",
  envJson: null,
  shell: null,
  pid: null,
  cols: null,
  rows: null,
  lastOutputSeq: 0,
  startedAt: null,
  closedAt: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

describe("/api/tasks/[taskId]/terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: ACTIVE_USER.id,
      email: ACTIVE_USER.email,
      phone: ACTIVE_USER.phone,
    } as any);
    vi.mocked(db.user.findUnique).mockResolvedValue(ACTIVE_USER as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(aiTaskFixture as any);
    vi.mocked(db.attachedTerminal.findUnique).mockResolvedValue(null);
    const attachedFixture = {
      id: "attached-1",
      aiTaskId: "ai-1",
      ptyTaskId: "pty-attached-1",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    // `createAttachedTerminalRecord` now uses array-form `$transaction([...])`
    // instead of an interactive callback. The test mock returns the same
    // three fixtures in the same order the production code expects to
    // destructure them (`[ptyTask, ptySession, attached]`).
    vi.mocked(db.task.create).mockResolvedValue(ptyTaskFixture as any);
    vi.mocked(db.ptySession.create).mockResolvedValue(ptySessionFixture as any);
    vi.mocked(db.attachedTerminal.create).mockResolvedValue(attachedFixture as any);
    vi.mocked(db.$transaction).mockImplementation(async (input: any) => {
      if (typeof input === "function") {
        // Legacy interactive transaction path (kept for other call sites).
        return input({
          task: { create: vi.fn().mockResolvedValue(ptyTaskFixture) },
          ptySession: { create: vi.fn().mockResolvedValue(ptySessionFixture) },
          attachedTerminal: { create: vi.fn().mockResolvedValue(attachedFixture) },
        });
      }
      if (Array.isArray(input)) {
        return Promise.all(input);
      }
      return input;
    });
  });

  describe("POST", () => {
    it("creates an attached terminal bound to the AI task", async () => {
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
        body: {},
      });
      const response = await POST(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      const data = await extractJson(response);
      expect(response.status).toBe(201);
      expect(data.ai_task_id).toBe("ai-1");
      expect(data.pty_task_id).toBe("pty-attached-1");
      expect(data.pty_task.task_type).toBe("pty_task");
    });

    it("returns 409 when the AI task already has an attached terminal", async () => {
      vi.mocked(db.attachedTerminal.findUnique).mockResolvedValue({
        id: "attached-existing",
        aiTaskId: "ai-1",
        ptyTaskId: "pty-existing",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
        body: {},
      });
      const response = await POST(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      expect(response.status).toBe(409);
    });

    it("rejects non-AI tasks", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue({
        ...aiTaskFixture,
        taskType: "pty_task",
      } as any);
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        url: "http://localhost/api/tasks/pty-x/terminal",
        token,
        body: {},
      });
      const response = await POST(request, {
        params: Promise.resolve({ taskId: "pty-x" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 404 when the AI task does not belong to the user", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(null);
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        url: "http://localhost/api/tasks/missing/terminal",
        token,
        body: {},
      });
      const response = await POST(request, {
        params: Promise.resolve({ taskId: "missing" }),
      });
      expect(response.status).toBe(404);
    });

    it("routes the PTY to the project daemon when the AI task is bound to a conductor-fire host", async () => {
      // Fire-bound AI task: agentHost is the short-lived fire process, the
      // long-running daemon lives at `project.daemonHost`. The PTY must land
      // on the daemon — fire does not advertise `pty_task`.
      vi.mocked(db.task.findFirst).mockResolvedValue({
        ...aiTaskFixture,
        agentHost: "conductor-fire-unknown-host-53658",
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
        body: {},
      });
      const response = await POST(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      expect(response.status).toBe(201);
      // PTY task row gets the daemon host, not the fire host.
      const createArgs = vi.mocked(db.task.create).mock.calls[0]?.[0] as any;
      expect(createArgs?.data?.agentHost).toBe("host.local");
    });

    it("inherits the worktree cwd from a worktree AI task so the terminal opens in the same on-disk directory", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue({
        ...aiTaskFixture,
        launchConfig: JSON.stringify({
          worktree: true,
          worktreeId: "ai-1",
          worktreeBranch: "feature/login",
          worktreeBaseRef: "main",
          projectRepoRoot: "/repo",
          projectWorkspacePath: "/repo",
          projectRelativePath: ".",
        }),
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "POST",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
        body: {},
      });
      const response = await POST(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      expect(response.status).toBe(201);
      // PtySession seed carries the resolved worktree cwd (`/`-separated
      // because the sample paths are POSIX). The path math mirrors
      // `cli/src/daemon.js buildTaskWorktreeRoot` — sanitize "/" to "_".
      const ptySessionArgs = vi.mocked(db.ptySession.create).mock.calls[0]?.[0] as any;
      expect(ptySessionArgs?.data?.cwd).toBe("/repo/.conductor/worktrees/feature_login");
      const taskArgs = vi.mocked(db.task.create).mock.calls[0]?.[0] as any;
      const taskLaunchConfig = JSON.parse(taskArgs?.data?.launchConfig ?? "{}");
      expect(taskLaunchConfig.cwd).toBe("/repo/.conductor/worktrees/feature_login");
    });
  });

  describe("GET", () => {
    it("returns 404 when no terminal is attached", async () => {
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "GET",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
      });
      const response = await GET(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      expect(response.status).toBe(404);
    });

    it("returns the attached terminal summary when present", async () => {
      vi.mocked(db.attachedTerminal.findUnique).mockResolvedValue({
        id: "attached-1",
        aiTaskId: "ai-1",
        ptyTaskId: "pty-attached-1",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      } as any);
      // After the AI-task lookup, `loadAttachedPtyTask` runs a second
      // `findFirst` for the PTY row with project.userId scope. Return the
      // PTY task when that call comes in.
      vi.mocked(db.task.findFirst).mockImplementation(async (args: any) => {
        if (args?.where?.id === "ai-1") return aiTaskFixture as any;
        if (args?.where?.id === "pty-attached-1") {
          return { ...ptyTaskFixture, ptySession: ptySessionFixture } as any;
        }
        return null;
      });
      vi.mocked(db.task.findUnique).mockResolvedValue({
        ...ptyTaskFixture,
        ptySession: ptySessionFixture,
      } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "GET",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
      });
      const response = await GET(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      const data = await extractJson(response);
      expect(response.status).toBe(200);
      expect(data.pty_task_id).toBe("pty-attached-1");
      expect(data.pty_task.task_type).toBe("pty_task");
    });
  });

  describe("DELETE", () => {
    it("is idempotent when no terminal is attached", async () => {
      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
      });
      const response = await DELETE(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      expect(response.status).toBe(204);
    });

    it("deletes the underlying PTY task (which cascades the attachment row)", async () => {
      vi.mocked(db.attachedTerminal.findUnique).mockResolvedValue({
        id: "attached-1",
        aiTaskId: "ai-1",
        ptyTaskId: "pty-attached-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      vi.mocked(db.task.findFirst).mockImplementation(async (args: any) => {
        // First call: lookup AI task (in fetchAiTask)
        // Second call: lookup PTY task inside deletePtyTaskWithKill
        if (args?.where?.id === "ai-1") return aiTaskFixture as any;
        if (args?.where?.id === "pty-attached-1") {
          return {
            id: "pty-attached-1",
            projectId: "proj-1",
            taskType: "pty_task",
            agentHost: "host.local",
            executionHost: null,
            status: "running",
            project: { daemonHost: "host.local" },
          } as any;
        }
        return null;
      });
      vi.mocked(db.task.delete).mockResolvedValue(ptyTaskFixture as any);
      vi.mocked(db.message.deleteMany).mockResolvedValue({ count: 0 } as any);
      vi.mocked(db.ptySession.deleteMany).mockResolvedValue({ count: 1 } as any);

      const token = createTestToken("user-1");
      const request = createMockRequest({
        method: "DELETE",
        url: "http://localhost/api/tasks/ai-1/terminal",
        token,
      });
      const response = await DELETE(request, {
        params: Promise.resolve({ taskId: "ai-1" }),
      });
      expect(response.status).toBe(204);
      expect(db.task.delete).toHaveBeenCalledWith({ where: { id: "pty-attached-1" } });
    });
  });
});
