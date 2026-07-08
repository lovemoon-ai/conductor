import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/tasks/[taskId]/scheduled-messages/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/tasks/scheduled-messages", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tasks/scheduled-messages")>();
  return {
    ...original,
    createScheduledMessageForTask: vi.fn(),
    listScheduledMessagesForTask: vi.fn(),
  };
});

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const {
  ScheduledMessageError,
  createScheduledMessageForTask,
  listScheduledMessagesForTask,
} = await import("@/lib/tasks/scheduled-messages");

describe("/api/tasks/[taskId]/scheduled-messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(createScheduledMessageForTask).mockResolvedValue({
      id: "sched-1",
      userId: "user-1",
      taskId: "task-1",
      sourceMessageId: "msg-1",
      content: "hello later",
      kind: "interval",
      condition: "ai_idle",
      intervalMs: 3_600_000,
      timezone: null,
      status: "active",
      nextRunAt: "2026-06-07T11:00:00.000Z",
      runCount: 0,
      skipCount: 0,
      failureCount: 0,
      maxRuns: 3,
      maxSkips: null,
      stopAt: null,
      stopWhenTaskNotRunning: true,
      lastRunAt: null,
      lastError: null,
      createdAt: "2026-06-07T10:00:00.000Z",
      updatedAt: "2026-06-07T10:00:00.000Z",
    });
    vi.mocked(listScheduledMessagesForTask).mockResolvedValue([]);
  });

  it("creates an idle-gated interval scheduled message", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages",
        body: {
          content: "hello later",
          sourceMessageId: "msg-1",
          schedule: {
            mode: "interval",
            every: 1,
            unit: "hour",
            condition: "ai_idle",
            stop: {
              maxRuns: 3,
              stopWhenTaskNotRunning: true,
            },
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(201);
    expect(data.id).toBe("sched-1");
    expect(createScheduledMessageForTask).toHaveBeenCalledWith({
      userId: "user-1",
      taskId: "task-1",
      sourceMessageId: "msg-1",
      content: "hello later",
      schedule: {
        mode: "interval",
        every: 1,
        unit: "hour",
        condition: "ai_idle",
        stop: {
          maxRuns: 3,
          stopWhenTaskNotRunning: true,
        },
      },
    });
  });

  it("rejects malformed schedule requests", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages",
        body: {
          content: "hello later",
          schedule: {
            mode: "delay",
            amount: 0,
            unit: "minute",
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("invalid_request");
    expect(createScheduledMessageForTask).not.toHaveBeenCalled();
  });

  it("returns service validation errors when the source message is not in the task", async () => {
    vi.mocked(createScheduledMessageForTask).mockRejectedValueOnce(
      new ScheduledMessageError("source_message_not_found", 404, "Source message not found", {
        error: "source_message_not_found",
        message: "Source message not found",
      }),
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages",
        body: {
          content: "hello later",
          sourceMessageId: "msg-other-task",
          schedule: {
            mode: "delay",
            amount: 10,
            unit: "minute",
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(404);
    expect(data.error).toBe("source_message_not_found");
  });

  it("lists scheduled messages for a task", async () => {
    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:6152/api/tasks/task-1/scheduled-messages",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ schedules: [] });
    expect(listScheduledMessagesForTask).toHaveBeenCalledWith({
      userId: "user-1",
      taskId: "task-1",
    });
  });
});
