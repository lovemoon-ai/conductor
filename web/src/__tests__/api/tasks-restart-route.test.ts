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
    waitForAgentCommandAck: vi.fn().mockResolvedValue(true),
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
    project: {
      findFirst: vi.fn(),
    },
    defaultProject: {
      findUnique: vi.fn(),
    },
    agentOutbox: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { deliverAgentOutboxForHost } = await import("@/lib/realtime/agent-outbox");

const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

const buildTask = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  projectId: "proj-1",
  issueId: null,
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
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      daemonHost: "daemon-1",
      workspacePath: "/repo/project",
    } as any);
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue(null);
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
    vi.mocked(db.agentOutbox.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-1",
        supportedBackends: ["codex", "claude", "kimi", "opencode"],
        capabilities: ["refresh_session_inplace"],
      },
    ] as any);
    vi.mocked(realtimeHub.waitForAgentCommandAck).mockResolvedValue(true);
  });

  it("dispatches restart_task for same-backend restart and returns the source task as running", async () => {
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
    expect(data.task.status).toBe("running");
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

  it("refreshes a running task session in place without mutating task ownership or status", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ status: "running", executionHost: "conductor-fire-test-1" }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "conductor-fire-test-1",
        supportedBackends: ["codex"],
        capabilities: ["refresh_session_inplace"],
      },
      {
        id: "agent-2",
        host: "daemon-1",
        supportedBackends: ["codex", "claude", "kimi", "opencode"],
        capabilities: ["refresh_session_inplace"],
      },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(data.task.status).toBe("running");
    expect(data.task.agent_host).toBe("daemon-1");
    expect(data.task.execution_host).toBe("conductor-fire-test-1");
    expect(db.task.update).not.toHaveBeenCalled();
    expect(realtimeHub.bindTaskToAgent).not.toHaveBeenCalled();
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: "task-1",
          agentHost: "conductor-fire-test-1",
          eventType: "refresh_session",
          payloadJson: expect.stringContaining('"type":"refresh_session"'),
        }),
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      60_000,
      {
        expectedHosts: ["conductor-fire-test-1"],
        eventType: "refresh_session",
      },
    );
  });

  it("prefers the realtime fire binding when persisted task hosts are stale during session refresh", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ status: "running", agentHost: "daemon-1", executionHost: "daemon-1" }) as any,
    );
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-live-1");
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "conductor-fire-live-1",
        supportedBackends: ["codex"],
        capabilities: ["refresh_session_inplace"],
      },
      {
        id: "agent-2",
        host: "daemon-1",
        supportedBackends: ["codex", "claude", "kimi", "opencode"],
        capabilities: ["refresh_session_inplace"],
      },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "conductor-fire-live-1",
          eventType: "refresh_session",
        }),
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      60_000,
      {
        expectedHosts: ["conductor-fire-live-1"],
        eventType: "refresh_session",
      },
    );
  });

  it("ignores a stale realtime fire binding when executionHost already points at a different fire host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "daemon-1",
        executionHost: "conductor-fire-current-1",
      }) as any,
    );
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-stale-1");
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "conductor-fire-current-1",
        supportedBackends: ["codex"],
        capabilities: ["refresh_session_inplace"],
      },
      {
        id: "agent-2",
        host: "conductor-fire-stale-1",
        supportedBackends: ["codex"],
        capabilities: ["refresh_session_inplace"],
      },
      {
        id: "agent-3",
        host: "daemon-1",
        supportedBackends: ["codex", "claude", "kimi", "opencode"],
        capabilities: ["refresh_session_inplace"],
      },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "conductor-fire-current-1",
          eventType: "refresh_session",
        }),
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      60_000,
      {
        expectedHosts: ["conductor-fire-current-1"],
        eventType: "refresh_session",
      },
    );
  });

  it("returns 502 when fire rejects session refresh", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ status: "running", executionHost: "conductor-fire-test-1" }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "conductor-fire-test-1",
        supportedBackends: ["codex"],
        capabilities: ["refresh_session_inplace"],
      },
    ] as any);
    vi.mocked(realtimeHub.waitForAgentCommandAck).mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(502);
    expect(data.error).toContain("rejected");
  });

  it("marks refresh outbox command failed when fire ack times out", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ status: "running", executionHost: "conductor-fire-test-1" }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "conductor-fire-test-1",
        supportedBackends: ["codex"],
        capabilities: ["refresh_session_inplace"],
      },
    ] as any);
    vi.mocked(realtimeHub.waitForAgentCommandAck).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(504);
    expect(data.error).toContain("Timed out");
    expect(db.agentOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        requestId: expect.any(String),
        status: { in: ["pending", "sent"] },
      },
      data: {
        status: "failed",
        nextRetryAt: null,
        lastError: "ack_timeout:refresh_session",
      },
    });
  });

  it("returns 409 when fire does not advertise session refresh support", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ status: "running", executionHost: "conductor-fire-test-1" }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "conductor-fire-test-1",
        supportedBackends: ["codex"],
        capabilities: [],
      },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("does not support AI session refresh");
    expect(db.agentOutbox.create).not.toHaveBeenCalled();
    expect(realtimeHub.waitForAgentCommandAck).not.toHaveBeenCalled();
  });

  it("allows in-place restart for tasks in unknown status", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask({ status: "unknown" }) as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { strategy: "inplace" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: "task-1",
          payloadJson: expect.stringContaining('"mode":"resume_inplace"'),
        }),
      }),
    );
  });

  it("includes the source worktree launch config for in-place restart", async () => {
    const worktreeLaunchConfig = {
      worktree: true,
      worktreeId: "task-1",
      worktreeBranch: "conductor/task/task-1",
      worktreeBaseRef: "main",
      projectRepoRoot: "/repo/project",
      projectWorkspacePath: "/repo/project/packages/app",
      projectRelativePath: "packages/app",
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        launchConfig: JSON.stringify(worktreeLaunchConfig),
      }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { strategy: "inplace" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);
    const payloadJson = vi.mocked(db.agentOutbox.create).mock.calls.at(-1)?.[0]?.data?.payloadJson as string;

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(JSON.parse(payloadJson).payload.target_launch_config).toEqual(worktreeLaunchConfig);
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

  it("returns 409 when task daemon does not match project binding", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex"], capabilities: [] },
      { id: "agent-2", host: "daemon-2", supportedBackends: ["codex"], capabilities: [] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask({ agentHost: "daemon-1" }) as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      daemonHost: "daemon-2",
      workspacePath: "/repo/project",
    } as any);

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
    expect(data.error).toContain("does not match project binding");
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

  it("returns 409 when backend_type is explicitly provided but unsupported by the daemon", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { backend_type: "not-a-backend" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("does not support backend not-a-backend");
  });

  it("allows same-backend restart for external providers supported by the daemon", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        title: "External task",
        status: "running",
        backendType: "test-external",
        sessionId: "ext-session-1",
        sessionFilePath: null,
      }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["test-external"], capabilities: [] },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { backend_type: "test-external", strategy: "new_task" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("successor_new_task");
    expect(data.task.backend_type).toBe("test-external");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: expect.any(String),
          eventType: "restart_task",
          payloadJson: expect.stringContaining('"target_backend_type":"test-external"'),
        }),
      }),
    );
  });

  it("restarts a stopped conductor-fire task in place on an online daemon", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
      { id: "agent-2", host: "daemon-2", supportedBackends: ["codex", "claude"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ agentHost: "conductor-fire-debug-1", executionHost: "daemon-2" }) as any,
    );
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      daemonHost: "daemon-2",
      workspacePath: "/repo/project",
    } as any);

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
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({
          status: "running",
          agentHost: "daemon-2",
          executionHost: "daemon-2",
        }),
      }),
    );
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "daemon-2",
          payloadJson: expect.stringContaining('"mode":"resume_inplace"'),
        }),
      }),
    );
  });

  it("returns 409 when a conductor-fire task's original execution daemon is offline", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex", "claude"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ agentHost: "conductor-fire-debug-1", executionHost: "daemon-2" }) as any,
    );
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      daemonHost: "daemon-2",
      workspacePath: "/repo/project",
    } as any);

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
    expect(data.error).toContain("Project daemon daemon-2 is offline");
  });

  it("restarts a stopped conductor-fire task using metadata daemonName when executionHost is unavailable", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex", "claude"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        agentHost: "conductor-fire-debug-1",
        executionHost: null,
        metadata: JSON.stringify({ daemonName: "daemon-1" }),
      }) as any,
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

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "daemon-1",
          payloadJson: expect.stringContaining('"mode":"resume_inplace"'),
        }),
      }),
    );
  });

  it("uses the project daemon binding for conductor-fire backend switches when task daemon metadata is unavailable", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex", "claude"], capabilities: [] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "conductor-fire-debug-1",
        metadata: null,
      }) as any,
    );
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      daemonHost: "daemon-1",
      workspacePath: "/repo/project",
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { backend_type: "claude", strategy: "new_task" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("backend_switch_new_task");
    expect(data.task.backend_type).toBe("claude");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "daemon-1",
          payloadJson: expect.stringContaining('"target_backend_type":"claude"'),
        }),
      }),
    );
  });

  it("allows running conductor-fire task to create new task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "daemon-1",
      }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { strategy: "new_task" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("successor_new_task");
  });

  it("allows running conductor-fire task to refresh its session on the fire host", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "conductor-fire-debug-1", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "daemon-1",
      }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(data.task.agent_host).toBe("conductor-fire-debug-1");
    expect(data.task.execution_host).toBe("daemon-1");
    expect(db.task.update).not.toHaveBeenCalled();
    expect(realtimeHub.bindTaskToAgent).not.toHaveBeenCalled();
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "conductor-fire-debug-1",
          eventType: "refresh_session",
          payloadJson: expect.stringContaining('"type":"refresh_session"'),
        }),
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      60_000,
      {
        expectedHosts: ["conductor-fire-debug-1"],
        eventType: "refresh_session",
      },
    );
  });

  it("refreshes running conductor-fire task using its fire execution host", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "conductor-fire-debug-1", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "conductor-fire-debug-1",
        metadata: JSON.stringify({ daemonName: "daemon-1" }),
      }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "conductor-fire-debug-1",
          eventType: "refresh_session",
          payloadJson: expect.stringContaining('"type":"refresh_session"'),
        }),
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      60_000,
      {
        expectedHosts: ["conductor-fire-debug-1"],
        eventType: "refresh_session",
      },
    );
  });

  it("refreshes running conductor-fire task on its fire execution host instead of project binding", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "conductor-fire-debug-1", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
      { id: "agent-2", host: "daemon-2", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "daemon-1",
      }) as any,
    );
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      daemonHost: "daemon-2",
      workspacePath: "/repo/project",
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "conductor-fire-debug-1",
          eventType: "refresh_session",
          payloadJson: expect.stringContaining('"type":"refresh_session"'),
        }),
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      60_000,
      {
        expectedHosts: ["conductor-fire-debug-1"],
        eventType: "refresh_session",
      },
    );
  });

  it("refreshes running conductor-fire task on fire executionHost when metadata daemonName disagrees", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
      { id: "agent-2", host: "conductor-fire-debug-2", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "conductor-fire-debug-2",
        metadata: JSON.stringify({ daemonName: "daemon-1" }),
      }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("inplace_restart");
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentHost: "conductor-fire-debug-2",
          eventType: "refresh_session",
          payloadJson: expect.stringContaining('"type":"refresh_session"'),
        }),
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      60_000,
      {
        expectedHosts: ["conductor-fire-debug-2"],
        eventType: "refresh_session",
      },
    );
  });

  it("returns 409 when the fire host is offline for a running conductor-fire refresh", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-1", host: "daemon-1", supportedBackends: ["codex"], capabilities: ["refresh_session_inplace"] },
    ] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "conductor-fire-debug-1",
        metadata: JSON.stringify({ daemonName: "daemon-3" }),
      }) as any,
    );
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      daemonHost: "daemon-1",
      workspacePath: "/repo/project",
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { restart_mode: "refresh_session" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("Fire host conductor-fire-debug-1 is offline");
    expect(db.agentOutbox.create).not.toHaveBeenCalled();
    expect(realtimeHub.waitForAgentCommandAck).not.toHaveBeenCalled();
  });

  it("returns 409 when a running conductor-fire task tries inplace restart", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        agentHost: "conductor-fire-debug-1",
        executionHost: "daemon-1",
      }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { strategy: "inplace" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("only in-place restart after it has stopped");
  });

  it("returns 409 when source task is still running", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask({ status: "running" }) as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { strategy: "inplace" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("In-place");
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
    expect(data.task.status).toBe("init");
    expect(data.task.title).toBe("Fix login bug [claude]");
    expect(data.task.backend_type).toBe("claude");
    expect(data.task.session_id).toBeNull();
    expect(data.task.launch_config).toEqual({
      cwd: "/repo/project",
    });
    expect(data.task.metadata).toEqual({
      continuedFromTaskId: "task-1",
      restartSourceBackendType: "codex",
      restartStrategy: "new_task",
    });
    expect(db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          launchConfig: JSON.stringify({
            cwd: "/repo/project",
          }),
        }),
      }),
    );
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
          payloadJson: expect.stringContaining('"mode":"fork_to_new_task"'),
        }),
      }),
    );
  });

  it("creates a successor task when the source task uses a configured codex alias and switches to claude", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        backendType: "codex-gamma",
        sessionId: "sess-codex-gamma-1",
      }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-1",
        supportedBackends: ["codex-gamma", "claude"],
        runtimeBackendMap: {
          "codex-gamma": "codex",
          claude: "claude",
        },
        capabilities: [],
      },
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

    expect(response.status).toBe(200);
    expect(data.mode).toBe("backend_switch_new_task");
    expect(data.task.backend_type).toBe("claude");
    expect(data.task.metadata).toEqual({
      continuedFromTaskId: "task-1",
      restartSourceBackendType: "codex-gamma",
      restartStrategy: "new_task",
    });
  });

  it("creates a successor task when switching between configured codex aliases", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        backendType: "codex-gamma",
        sessionId: "sess-codex-gamma-2",
      }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-1",
        supportedBackends: ["codex-gamma", "codex-beta"],
        runtimeBackendMap: {
          "codex-gamma": "codex",
          "codex-beta": "codex",
        },
        capabilities: [],
      },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { backend_type: "codex-beta" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("backend_switch_new_task");
    expect(data.task.backend_type).toBe("codex-beta");
    expect(data.task.metadata).toEqual({
      continuedFromTaskId: "task-1",
      restartSourceBackendType: "codex-gamma",
      restartStrategy: "new_task",
    });
  });

  it("rejects backend switches for external backends that only share a built-in-looking prefix", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        backendType: "codex-enterprise",
        sessionId: "sess-codex-enterprise-1",
      }) as any,
    );
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-1",
        host: "daemon-1",
        supportedBackends: ["codex-enterprise", "claude"],
        runtimeBackendMap: {
          "codex-enterprise": "codex-enterprise",
          claude: "claude",
        },
        capabilities: [],
      },
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
    expect(data.error).toContain("Backend switch codex-enterprise -> claude is not supported");
  });

  it("creates a successor task for a running task on the same backend", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask({ status: "running" }) as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {
          backend_type: "codex",
          strategy: "new_task",
        },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("successor_new_task");
    expect(data.source_task_id).toBe("task-1");
    expect(data.task.id).not.toBe("task-1");
    expect(data.task.status).toBe("init");
    expect(data.task.backend_type).toBe("codex");
    expect(data.task.metadata).toEqual({
      continuedFromTaskId: "task-1",
      restartSourceBackendType: "codex",
      restartStrategy: "new_task",
    });
    expect(db.agentOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: expect.any(String),
          payloadJson: expect.stringContaining('"mode":"fork_to_new_task"'),
        }),
      }),
    );
    expect(vi.mocked(db.agentOutbox.create).mock.calls.at(-1)?.[0]?.data?.payloadJson).toContain(
      '"target_backend_type":"codex"',
    );
  });

  it("preserves issue linkage for successor restart tasks", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ status: "running", issueId: "issue-42" }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {
          backend_type: "codex",
          strategy: "new_task",
        },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("successor_new_task");
    expect(data.task.issue_id).toBe("issue-42");
    expect(db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issueId: "issue-42",
        }),
      }),
    );
  });

  it("falls back to restart source reads when issue relation columns are missing", async () => {
    vi.mocked(db.task.findFirst)
      .mockRejectedValueOnce(
        prismaError("P2022", "The column `tasks.issue_id` does not exist in the current database."),
      )
      .mockResolvedValueOnce(buildTask({ status: "running" }) as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {
          backend_type: "codex",
          strategy: "new_task",
        },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);
    const legacyReadCall = vi.mocked(db.task.findFirst).mock.calls[1]?.[0];

    expect(response.status).toBe(200);
    expect(data.mode).toBe("successor_new_task");
    expect(legacyReadCall?.select).not.toHaveProperty("issueId");
    expect(data.task.issue_id).toBeNull();
  });

  it("falls back to successor creation without issueId when issue relation columns are missing", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({ status: "running", issueId: "issue-42" }) as any,
    );
    vi.mocked(db.task.create)
      .mockRejectedValueOnce(
        prismaError("P2022", "The column `tasks.issue_id` does not exist in the current database."),
      )
      .mockResolvedValueOnce({
        ...buildTask({
          id: "task-successor",
          status: "init",
          agentHost: "daemon-1",
          executionHost: null,
          backendType: "codex",
          sessionId: null,
          sessionFilePath: null,
          launchConfig: JSON.stringify({ cwd: "/repo/project" }),
          metadata: JSON.stringify({
            continuedFromTaskId: "task-1",
            restartSourceBackendType: "codex",
            restartStrategy: "new_task",
          }),
          createdAt: new Date("2026-03-24T10:10:00.000Z"),
          updatedAt: new Date("2026-03-24T10:10:00.000Z"),
        }),
        issueId: undefined,
      } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: {
          backend_type: "codex",
          strategy: "new_task",
        },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);
    const firstCreateCall = vi.mocked(db.task.create).mock.calls[0]?.[0];
    const fallbackCreateCall = vi.mocked(db.task.create).mock.calls[1]?.[0];

    expect(response.status).toBe(200);
    expect(firstCreateCall?.data).toEqual(expect.objectContaining({ issueId: "issue-42" }));
    expect(fallbackCreateCall?.data).not.toHaveProperty("issueId");
    expect(fallbackCreateCall?.select).not.toHaveProperty("issueId");
    expect(data.task.issue_id).toBeNull();
  });

  it("inherits the same worktree launch config for successor tasks", async () => {
    const worktreeLaunchConfig = {
      worktree: true,
      worktreeId: "task-1",
      worktreeBranch: "conductor/task/task-1",
      worktreeBaseRef: "main",
      projectRepoRoot: "/repo/project",
      projectWorkspacePath: "/repo/project/packages/app",
      projectRelativePath: "packages/app",
    };
    vi.mocked(db.task.findFirst).mockResolvedValue(
      buildTask({
        status: "running",
        launchConfig: JSON.stringify(worktreeLaunchConfig),
      }) as any,
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        body: { strategy: "new_task" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);
    const payloadJson = vi.mocked(db.agentOutbox.create).mock.calls.at(-1)?.[0]?.data?.payloadJson as string;

    expect(response.status).toBe(200);
    expect(data.mode).toBe("successor_new_task");
    expect(data.task.launch_config).toEqual(worktreeLaunchConfig);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: {
          updatedAt: expect.any(Date),
        },
      }),
    );
    expect(db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          launchConfig: JSON.stringify(worktreeLaunchConfig),
        }),
      }),
    );
    expect(JSON.parse(payloadJson).payload.target_launch_config).toEqual(worktreeLaunchConfig);
  });
});
