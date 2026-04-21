import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/interrupt/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
    waitForAgentCommandAck: vi.fn(),
  },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");

describe("/api/tasks/[taskId]/interrupt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(realtimeHub.waitForAgentCommandAck).mockResolvedValue(true);
  });

  it("sends an interrupt_turn command to the persisted manual fire owner", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "conductor-fire-a",
      executionHost: "conductor-fire-a",
      metadata: JSON.stringify({ daemonName: "daemon-a" }),
      project: { daemonHost: "daemon-a" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-bound");
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-1" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledTimes(1);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "conductor-fire-a",
      {
        type: "interrupt_turn",
        payload: expect.objectContaining({
          task_id: "task-1",
          project_id: "proj-1",
          target_reply_to: "msg-user-1",
          reason: "user_interrupt",
          request_id: expect.any(String),
        }),
      },
    );
    expect(data).toEqual(
      expect.objectContaining({
        delivered: true,
        task_id: "task-1",
        target_reply_to: "msg-user-1",
        request_id: expect.any(String),
        agent_host: "conductor-fire-a",
        agent_hosts: ["conductor-fire-a"],
        task_model: "manual_fire",
        daemon_host: "daemon-a",
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      2500,
      {
        expectedHosts: ["conductor-fire-a"],
        eventType: "interrupt_turn",
      },
    );
  });

  it("does not let a stale bound fire host override the app task execution host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-agent-1",
      executionHost: "conductor-fire-runtime",
      metadata: JSON.stringify({ daemonName: "daemon-agent-1" }),
      project: { daemonHost: "daemon-agent-1" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-stale");
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-2" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledTimes(1);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "conductor-fire-runtime",
      expect.objectContaining({
        type: "interrupt_turn",
      }),
    );
    expect(data).toEqual(
      expect.objectContaining({
        delivered: true,
        agent_host: "conductor-fire-runtime",
        agent_hosts: ["conductor-fire-runtime"],
        task_model: "app",
        daemon_host: "daemon-agent-1",
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      2500,
      {
        expectedHosts: ["conductor-fire-runtime"],
        eventType: "interrupt_turn",
      },
    );
  });

  it("ignores non-fire bindings and falls back to the runtime fire host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-agent-1",
      executionHost: "conductor-fire-runtime",
      metadata: JSON.stringify({ daemonName: "daemon-agent-1" }),
      project: { daemonHost: "daemon-agent-1" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-bound-1");
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-2" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledTimes(1);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "conductor-fire-runtime",
      expect.objectContaining({
        type: "interrupt_turn",
      }),
    );
    expect(data).toEqual(
      expect.objectContaining({
        delivered: true,
        agent_host: "conductor-fire-runtime",
        agent_hosts: ["conductor-fire-runtime"],
        task_model: "app",
        daemon_host: "daemon-agent-1",
      }),
    );
    expect(realtimeHub.waitForAgentCommandAck).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      2500,
      {
        expectedHosts: ["conductor-fire-runtime"],
        eventType: "interrupt_turn",
      },
    );
  });

  it("keeps manual fire routing on the fire owner while exposing the daemon association", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-2",
      projectId: "proj-2",
      taskType: "ai_task",
      status: "running",
      agentHost: "conductor-fire-manual",
      executionHost: "conductor-fire-manual",
      metadata: JSON.stringify({ daemonName: "daemon-project-1" }),
      project: { daemonHost: "daemon-project-1" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-project-1");
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-2/interrupt",
        body: { target_reply_to: "msg-user-manual" },
      }),
      { params: Promise.resolve({ taskId: "task-2" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(realtimeHub.sendToAgentHost).toHaveBeenCalledWith(
      "user-1",
      "conductor-fire-manual",
      expect.objectContaining({
        type: "interrupt_turn",
      }),
    );
    expect(data).toEqual(
      expect.objectContaining({
        delivered: true,
        agent_host: "conductor-fire-manual",
        agent_hosts: ["conductor-fire-manual"],
        task_model: "manual_fire",
        daemon_host: "daemon-project-1",
      }),
    );
  });

  it("rejects interrupt requests when all reached fire owners reject the command", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "conductor-fire-a",
      executionHost: "conductor-fire-a",
      metadata: JSON.stringify({ daemonName: "daemon-a" }),
      project: { daemonHost: "daemon-a" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-bound");
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.waitForAgentCommandAck).mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-1" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "Task fire owner rejected interrupt request",
      task_model: "manual_fire",
      daemon_host: "daemon-a",
      agent_hosts: ["conductor-fire-a"],
    });
  });

  it("rejects interrupt requests when no fire owner acknowledges the command in time", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "conductor-fire-a",
      executionHost: "conductor-fire-a",
      metadata: JSON.stringify({ daemonName: "daemon-a" }),
      project: { daemonHost: "daemon-a" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-bound");
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.waitForAgentCommandAck).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-1" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "Task fire owner did not acknowledge interrupt request",
      task_model: "manual_fire",
      daemon_host: "daemon-a",
      agent_hosts: ["conductor-fire-a"],
    });
  });

  it("rejects interrupt requests for pty_task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-1",
      projectId: "proj-1",
      taskType: "pty_task",
      status: "running",
      agentHost: "daemon-1",
      executionHost: "daemon-1",
      metadata: null,
      project: { daemonHost: "daemon-1" },
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-pty-1/interrupt",
        body: { target_reply_to: "msg-user-1" },
      }),
      { params: Promise.resolve({ taskId: "task-pty-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "task_type_not_interruptible",
      message: "pty_task does not support turn interruption",
    });
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
  });

  it("rejects interrupt requests when the task has no fire host binding", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-agent-1",
      executionHost: "daemon-runtime-1",
      metadata: JSON.stringify({ daemonName: "daemon-agent-1" }),
      project: { daemonHost: "daemon-agent-1" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("daemon-bound-1");

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-3" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "Task missing active fire owner",
      task_model: "app",
      daemon_host: "daemon-agent-1",
    });
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
    expect(realtimeHub.waitForAgentCommandAck).not.toHaveBeenCalled();
  });

  it("rejects app task interrupts when only the in-memory bound host is a fire host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "running",
      agentHost: "daemon-agent-1",
      executionHost: null,
      metadata: JSON.stringify({ daemonName: "daemon-agent-1" }),
      project: { daemonHost: "daemon-agent-1" },
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-stale");

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-3" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "Task missing active fire owner",
      task_model: "app",
      daemon_host: "daemon-agent-1",
    });
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
    expect(realtimeHub.waitForAgentCommandAck).not.toHaveBeenCalled();
  });

  it("rejects interrupt requests when the ai_task is not running", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      status: "completed",
      agentHost: "conductor-fire-a",
      executionHost: "conductor-fire-a",
      metadata: null,
      project: { daemonHost: "daemon-a" },
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: { target_reply_to: "msg-user-4" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "task_not_running",
      message: "Only running ai_task supports turn interruption",
    });
    expect(realtimeHub.sendToAgentHost).not.toHaveBeenCalled();
    expect(realtimeHub.waitForAgentCommandAck).not.toHaveBeenCalled();
  });

  it("requires a target reply id", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/interrupt",
        body: {},
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: "target_reply_to required" });
    expect(db.task.findFirst).not.toHaveBeenCalled();
    expect(realtimeHub.waitForAgentCommandAck).not.toHaveBeenCalled();
  });
});
