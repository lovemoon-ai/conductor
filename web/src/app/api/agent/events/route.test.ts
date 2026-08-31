import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/agent/events/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    taskStatusEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    agentOutbox: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    bindTaskToAgent: vi.fn(),
    hasAgentHost: vi.fn().mockReturnValue(false),
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    sendToAgentHost: vi.fn().mockReturnValue(true),
    broadcast: vi.fn(),
    notifyTaskStatus: vi.fn(),
    acknowledgeAgentCommand: vi.fn(),
    acknowledgeTaskStop: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  deliverAgentOutboxForHost: vi.fn().mockResolvedValue({ attempted: 0, delivered: 0 }),
  enqueueAndAttemptAgentCommand: vi.fn().mockResolvedValue({ requestId: "stop-1", delivered: true }),
  acknowledgeAgentCommand: vi.fn().mockResolvedValue({ count: 1 }),
  acknowledgeAgentCommandsThroughCursor: vi.fn().mockResolvedValue({ count: 0 }),
  isMissingAgentOutboxTableError: vi.fn().mockReturnValue(false),
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { acknowledgeAgentCommand, deliverAgentOutboxForHost, enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");

describe("/api/agent/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      agentHost: "daemon-1",
      executionHost: "daemon-1",
    } as any);
    vi.mocked(db.task.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-1",
      status: "running",
    } as any);
    vi.mocked(db.message.findUnique).mockResolvedValue(null);
    vi.mocked(db.message.create).mockResolvedValue({
      id: "msg-row-1",
      createdAt: new Date("2026-03-10T10:00:00.000Z"),
    } as any);
    vi.mocked(db.taskStatusEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.taskStatusEvent.create).mockResolvedValue({
      id: "status-row-1",
    } as any);
    vi.mocked(db.agentOutbox.findFirst).mockResolvedValue(null as any);
    vi.mocked(db.$transaction).mockImplementation(async (operations: any) => {
      if (Array.isArray(operations)) {
        return Promise.all(operations);
      }
      return operations;
    });
    vi.mocked(deliverAgentOutboxForHost).mockResolvedValue({ attempted: 0, delivered: 0 } as any);
    vi.mocked(acknowledgeAgentCommand).mockResolvedValue({ count: 1 } as any);
  });

  it("returns 401 without bearer token", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "http://localhost:6152/api/agent/events",
      body: { agent_host: "daemon-1", events: [] },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  it("commits sdk_message, task_status_update and agent_command_ack with idempotent replay", async () => {
    const token = createTestToken("user-1");
    const body = {
      agent_host: "daemon-1",
      events: [
        {
          event_type: "sdk_message",
          task_id: "task-1",
          content: "hello",
          metadata: { stream: true },
          message_id: "msg-1",
        },
        {
          event_type: "task_status_update",
          task_id: "task-1",
          status: "RUNNING",
          summary: "working",
          status_event_id: "status-1",
        },
        {
          event_type: "agent_command_ack",
          request_id: "req-1",
          task_id: "task-1",
          accepted: true,
          command_event_type: "stop_task",
        },
        {
          event_type: "task_stop_ack",
          task_id: "task-1",
          request_id: "req-stop-1",
          accepted: true,
        },
      ],
    };

    const firstResponse = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/agent/events",
        token,
        body,
      }),
    );
    const firstData = await extractJson(firstResponse);

    expect(firstResponse.status).toBe(200);
    expect(firstData.results).toEqual([
      expect.objectContaining({ event_type: "sdk_message", task_id: "task-1", message_id: "msg-1", duplicate: false }),
      expect.objectContaining({ event_type: "task_status_update", task_id: "task-1", status: "running", duplicate: false }),
      expect.objectContaining({ event_type: "agent_command_ack", request_id: "req-1", accepted: true, duplicate: false }),
      expect.objectContaining({ event_type: "task_stop_ack", task_id: "task-1", request_id: "req-stop-1", accepted: true, duplicate: false }),
    ]);
    expect(db.message.create).toHaveBeenCalledTimes(1);
    expect(db.taskStatusEvent.create).toHaveBeenCalledTimes(1);
    expect(acknowledgeAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        requestId: "req-1",
        accepted: true,
        eventType: "stop_task",
      }),
    );
    expect(acknowledgeAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        requestId: "req-stop-1",
        accepted: true,
        eventType: "task_stop_ack",
      }),
    );
    expect(realtimeHub.acknowledgeTaskStop).toHaveBeenCalledWith("task-1", "req-stop-1", true);
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_sdk_message",
      }),
    );
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_status_update",
      }),
    );

    vi.mocked(db.message.findUnique).mockResolvedValue({
      id: "msg-row-1",
      createdAt: new Date("2026-03-10T10:00:00.000Z"),
    } as any);
    vi.mocked(db.taskStatusEvent.findUnique).mockResolvedValue({
      id: "status-row-1",
    } as any);
    vi.mocked(acknowledgeAgentCommand).mockResolvedValue({ count: 0 } as any);

    const replayResponse = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/agent/events",
        token,
        body,
      }),
    );
    const replayData = await extractJson(replayResponse);

    expect(replayResponse.status).toBe(200);
    expect(replayData.results).toEqual([
      expect.objectContaining({ event_type: "sdk_message", duplicate: true }),
      expect.objectContaining({ event_type: "task_status_update", duplicate: true }),
      expect.objectContaining({ event_type: "agent_command_ack", duplicate: true }),
      expect.objectContaining({ event_type: "task_stop_ack", duplicate: true }),
    ]);
    expect(db.message.create).toHaveBeenCalledTimes(1);
    expect(db.taskStatusEvent.create).toHaveBeenCalledTimes(1);
    expect(realtimeHub.broadcast).toHaveBeenCalledTimes(2);
  });

  it("drops sdk_message for an already-killed task and durably stops the zombie backend", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      status: "killed",
      taskType: "ai_task",
      agentHost: "conductor-fire-zombie-1",
      executionHost: null,
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/agent/events",
        token,
        body: {
          agent_host: "conductor-fire-zombie-1",
          events: [
            {
              event_type: "sdk_message",
              task_id: "task-1",
              content: "zombie reply after kill",
              message_id: "msg-zombie-1",
            },
          ],
        },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.results).toEqual([
      expect.objectContaining({
        event_type: "sdk_message",
        task_id: "task-1",
        message_id: "msg-zombie-1",
        duplicate: true,
      }),
    ]);
    // The dead task is not resurrected: no message write, no re-bind / executionHost rewrite.
    expect(db.message.create).not.toHaveBeenCalled();
    expect(realtimeHub.bindTaskToAgent).not.toHaveBeenCalled();
    expect(db.task.updateMany).not.toHaveBeenCalled();
    // The zombie backend is durably stopped over the outbox with a matching requestId.
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledTimes(1);
    const [enqueueInput] = vi.mocked(enqueueAndAttemptAgentCommand).mock.calls[0];
    expect(enqueueInput).toMatchObject({
      agentHost: "conductor-fire-zombie-1",
      taskId: "task-1",
      eventType: "stop_task",
    });
    expect(enqueueInput.requestId).toBe(enqueueInput.envelope.payload.request_id);
  });

  it("bumps task activity time when committing a fresh sdk_message", async () => {
    const token = createTestToken("user-1");

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/agent/events",
        token,
        body: {
          agent_host: "daemon-1",
          events: [
            {
              event_type: "sdk_message",
              task_id: "task-1",
              content: "hello",
              metadata: { stream: true },
              message_id: "msg-touch-1",
            },
          ],
        },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.results).toEqual([
      expect.objectContaining({
        event_type: "sdk_message",
        task_id: "task-1",
        message_id: "msg-touch-1",
        duplicate: false,
      }),
    ]);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({
          updatedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("handles task_stop_ack without draining downstream outbox first", async () => {
    const token = createTestToken("user-1");
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/agent/events",
        token,
        body: {
          agent_host: "daemon-1",
          events: [
            {
              event_type: "task_stop_ack",
              task_id: "task-1",
              request_id: "req-stop-only-1",
              accepted: true,
            },
          ],
        },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.results).toEqual([
      expect.objectContaining({
        event_type: "task_stop_ack",
        task_id: "task-1",
        request_id: "req-stop-only-1",
        accepted: true,
      }),
    ]);
    expect(realtimeHub.acknowledgeTaskStop).toHaveBeenCalledWith("task-1", "req-stop-only-1", true);
    expect(deliverAgentOutboxForHost).not.toHaveBeenCalled();
  });

  it("allows conductor-fire hosts to commit sdk messages and promote init daemon-owned ai tasks", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-1",
      projectId: "proj-1",
      status: "init",
      taskType: "ai_task",
      agentHost: "debug",
      executionHost: null,
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/agent/events",
        token,
        body: {
          agent_host: "conductor-fire-debug-123",
          events: [
            {
              event_type: "sdk_message",
              task_id: "task-1",
              content: "5",
              message_id: "msg-fire-1",
            },
          ],
        },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.results).toEqual([
      expect.objectContaining({
        event_type: "sdk_message",
        task_id: "task-1",
        message_id: "msg-fire-1",
        duplicate: false,
      }),
    ]);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-1", "conductor-fire-debug-123", "user-1");
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        project: { userId: "user-1" },
        OR: [
          { executionHost: null },
          { executionHost: { not: "conductor-fire-debug-123" } },
        ],
      },
      data: { executionHost: "conductor-fire-debug-123" },
    });
    expect(db.task.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "running",
        executionHost: "conductor-fire-debug-123",
        updatedAt: expect.any(Date),
      }),
    });
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_status_update",
        payload: expect.objectContaining({
          task_id: "task-1",
          status: "running",
        }),
      }),
    );
  });

  it("allows conductor-fire hosts to repair stale daemon bindings when executionHost already points to fire", async () => {
    const token = createTestToken("user-1");
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: "task-1",
      projectId: "proj-1",
      status: "running",
      taskType: "ai_task",
      agentHost: "m1",
      executionHost: "conductor-fire-debug-123",
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("m1");
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/agent/events",
        token,
        body: {
          agent_host: "conductor-fire-debug-123",
          events: [
            {
              event_type: "sdk_message",
              task_id: "task-1",
              content: "reply after stale bind",
              message_id: "msg-fire-rebind-1",
            },
          ],
        },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.results).toEqual([
      expect.objectContaining({
        event_type: "sdk_message",
        task_id: "task-1",
        message_id: "msg-fire-rebind-1",
        duplicate: false,
      }),
    ]);
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith("task-1", "conductor-fire-debug-123", "user-1");
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        project: { userId: "user-1" },
        OR: [
          { executionHost: null },
          { executionHost: { not: "conductor-fire-debug-123" } },
        ],
      },
      data: { executionHost: "conductor-fire-debug-123" },
    });
  });
});
