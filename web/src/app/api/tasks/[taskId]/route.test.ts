import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/tasks/[taskId]/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    bindTaskToAgent: vi.fn(),
    sendToAgentHost: vi.fn(),
    getTaskAgentHost: vi.fn().mockReturnValue("daemon-a"),
    getAgentsForUser: vi.fn().mockReturnValue([]),
    hasAgentHost: vi.fn().mockReturnValue(true),
    getAgentDisconnectAt: vi.fn().mockReturnValue(null),
    unbindTask: vi.fn(),
    notifyTaskStatus: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  deliverAgentOutboxRow: vi.fn().mockResolvedValue(undefined),
  enqueueAndAttemptAgentCommand: vi.fn(),
  enqueueAgentCommand: vi.fn(),
  isMissingAgentOutboxTableError: vi.fn().mockReturnValue(false),
  warnMissingAgentOutboxTable: vi.fn(),
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

vi.mock("@/lib/diagnostics/task-diagnostics", () => ({
  buildTaskDiagnosticsPayload: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ptySession: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    agentOutbox: {
      create: vi.fn(),
    },
    attachedTerminal: {
      findUnique: vi.fn(),
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
const { deliverAgentOutboxRow } = await import("@/lib/realtime/agent-outbox");

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

const existingAiTask = {
  id: "ai-1",
  projectId: "proj-1",
  issueId: null,
  title: "AI task",
  taskType: "ai_task",
  status: "running",
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  backendType: "codex",
  sessionId: "session-1",
  sessionFilePath: null,
  launchConfig: null,
  metadata: null,
  lastUserMessage: null,
  lastAssistantMessage: null,
  ptySession: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

describe("/api/tasks/[taskId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: ACTIVE_USER.id,
      email: ACTIVE_USER.email,
      phone: ACTIVE_USER.phone,
    } as any);
    vi.mocked(db.user.findUnique).mockResolvedValue(ACTIVE_USER as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(existingAiTask as any);
    vi.mocked(db.task.update).mockImplementation(async ({ data }: any) => ({
      ...existingAiTask,
      ...data,
      updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    }));
    vi.mocked(db.agentOutbox.create).mockResolvedValue({
      id: "outbox-1",
      taskId: "ai-1",
      agentHost: "daemon-a",
      eventType: "stop_task",
      requestId: "req-stop-1",
      payloadJson: "{}",
      status: "pending",
      attemptCount: 0,
      nextRetryAt: null,
    } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) => {
      if (typeof callback !== "function") {
        return Array.isArray(callback) ? Promise.all(callback) : callback;
      }
      return callback({
        task: { update: db.task.update },
        agentOutbox: { create: db.agentOutbox.create },
      });
    });
    vi.mocked(db.attachedTerminal.findUnique).mockResolvedValue({
      id: "attached-1",
      ptyTaskId: "pty-1",
      ptyTask: { status: "running" },
    } as any);
  });

  it("keeps the attached PTY summary when a running AI task is killed", async () => {
    const request = createMockRequest({
      method: "PATCH",
      url: "http://localhost:6152/api/tasks/ai-1",
      token: createTestToken(ACTIVE_USER.id),
      body: { status: "killed" },
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ taskId: "ai-1" }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("killing");
    expect(data.attached_terminal).toEqual({
      id: "attached-1",
      pty_task_id: "pty-1",
      pty_task_status: "running",
    });
    expect(deliverAgentOutboxRow).toHaveBeenCalledTimes(1);
    expect(db.attachedTerminal.findUnique).toHaveBeenCalledWith({
      where: { aiTaskId: "ai-1" },
      select: {
        id: true,
        ptyTaskId: true,
        ptyTask: { select: { status: true } },
      },
    });
  });

  it("preserves server-owned group identity when metadata is cleared", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...existingAiTask,
      groupId: "group-1",
      metadata: JSON.stringify({
        groupId: "group-1",
        agentRole: "worker",
        agentName: "feature-dev",
        removable: true,
      }),
    } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:6152/api/tasks/ai-1",
        token: createTestToken(ACTIVE_USER.id),
        body: { metadata: null },
      }),
      { params: Promise.resolve({ taskId: "ai-1" }) },
    );

    expect(response.status).toBe(200);
    const update = vi.mocked(db.task.update).mock.calls.at(-1)?.[0] as any;
    expect(JSON.parse(update.data.metadata)).toEqual({
      groupId: "group-1",
      agentRole: "worker",
      agentName: "feature-dev",
    });
  });

  it("does not let PATCH forge group role or agent metadata", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...existingAiTask,
      groupId: "group-1",
      metadata: JSON.stringify({
        groupId: "group-1",
        agentRole: "reviewer",
        agentName: "code-reviewer",
      }),
    } as any);

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:6152/api/tasks/ai-1",
        token: createTestToken(ACTIVE_USER.id),
        body: {
          metadata: {
            groupId: "other-group",
            agentRole: "worker",
            agentName: "forged-agent",
            note: "safe user field",
          },
        },
      }),
      { params: Promise.resolve({ taskId: "ai-1" }) },
    );

    expect(response.status).toBe(200);
    const update = vi.mocked(db.task.update).mock.calls.at(-1)?.[0] as any;
    expect(JSON.parse(update.data.metadata)).toEqual({
      groupId: "group-1",
      agentRole: "reviewer",
      agentName: "code-reviewer",
      note: "safe user field",
    });
  });
});
