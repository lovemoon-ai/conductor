import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/restart/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    bindTaskToAgent: vi.fn(),
    sendToAgentHost: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  deliverAgentOutboxForHost: vi.fn().mockResolvedValue({ attempted: 1, delivered: 1 }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    agentOutbox: {
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { deliverAgentOutboxForHost } = await import("@/lib/realtime/agent-outbox");

const buildTask = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  projectId: "proj-1",
  title: "Fix login bug",
  taskType: "ai_task",
  status: "killed",
  agentHost: "daemon-1",
  executionHost: "daemon-1",
  backendType: "codex",
  sessionId: "sess-1",
  sessionFilePath: "/tmp/sess-1.jsonl",
  launchConfig: null,
  metadata: null,
  createdAt: new Date("2026-03-24T10:00:00.000Z"),
  updatedAt: new Date("2026-03-24T10:05:00.000Z"),
  ...overrides,
});

describe("/api/tasks/[taskId]/restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask() as any);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: "user-1",
      subscriptionTier: "PLUS",
    } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      callback({
        task: db.task,
        agentOutbox: db.agentOutbox,
      }),
    );
    vi.mocked(db.task.update).mockImplementation(async ({ where, data }: any) => ({
      ...buildTask(),
      id: where.id,
      ...data,
      createdAt: new Date("2026-03-24T10:00:00.000Z"),
      updatedAt: new Date("2026-03-24T10:10:00.000Z"),
    }) as any);
    vi.mocked(db.task.create).mockImplementation(async ({ data }: any) => ({
      ...buildTask(),
      ...data,
      status: data.status,
      executionHost: data.executionHost,
      backendType: data.backendType,
      sessionId: null,
      sessionFilePath: null,
      createdAt: new Date("2026-03-24T10:10:00.000Z"),
      updatedAt: new Date("2026-03-24T10:10:00.000Z"),
    }) as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex", "claude", "kimi", "opencode"], capabilities: [] },
    ] as any);
  });

  it("dispatches restart_task for same-backend restart and returns updated source task", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(data.source_task_id).toBe("task-1");
    expect(data.task.id).toBe("task-1");
    expect(data.task.status).toBe("unknown");
    expect(data.task.backend_type).toBe("codex");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: "task-1",
          eventType: "restart_task",
          payloadJson: expect.stringContaining('"mode":"resume_inplace"'),
        }),
      }),
    );
    expect(deliverAgentOutboxForHost).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        agentHost: "daemon-1",
      }),
    );
  });

  it("returns 409 when session binding is missing", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask({ sessionId: null }) as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("session binding");
  });

  it("returns 409 when target backend is not supported by the source daemon", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex"], capabilities: [] },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { backend_type: "claude" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("does not support backend claude");
  });

  it("returns 409 instead of 500 when source daemon presence is missing supportedBackends", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", capabilities: [] },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("does not support backend codex");
  });

  it("returns 400 when backend_type is explicitly provided but invalid", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { backend_type: "not-a-backend" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toContain("invalid backend_type");
  });

  it("returns 409 for conductor-fire tasks", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ agentHost: "conductor-fire-debug-1", executionHost: "conductor-fire-debug-1" }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("manual fire task");
  });

  it("returns 409 when source task is still running", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask({ status: "running" }) as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("stopped");
  });

  it("returns 409 when source daemon is missing or offline", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("offline");
  });

  it("creates a successor task for backend switch and keeps source status unchanged", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { backend_type: "claude" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("backend_switch_new_task");
    expect(data.source_task_id).toBe("task-1");
    expect(data.task.id).not.toBe("task-1");
    expect(data.task.title).toBe("Fix login bug [claude]");
    expect(data.task.backend_type).toBe("claude");
    expect(data.task.session_id).toBeNull();
    expect(data.task.metadata).toEqual({
      continuedFromTaskId: "task-1",
      restartSourceBackendType: "codex",
    });
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({
          metadata: expect.stringContaining("successorTaskId"),
        }),
      }),
    );
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: expect.any(String),
          payloadJson: expect.stringContaining('"mode":"bridge_to_new_task"'),
        }),
      }),
    );
  });
});
