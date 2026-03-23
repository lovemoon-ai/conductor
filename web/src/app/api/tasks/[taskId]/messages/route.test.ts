import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/tasks/[taskId]/messages/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    getTaskAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");

describe("/api/tasks/[taskId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  it("rejects POST for pty_task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-pty-1",
      projectId: "proj-1",
      taskType: "pty_task",
      agentHost: "daemon-1",
      executionHost: "daemon-1",
    } as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-pty-1/messages",
        body: { content: "hello terminal" },
      }),
      { params: Promise.resolve({ taskId: "task-pty-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "task_type_not_messageable",
      message: "pty_task does not accept chat messages",
    });
    expect(db.message.create).not.toHaveBeenCalled();
    expect(realtimeHub.broadcast).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("returns full message history array by default for backward compatibility", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
    } as any);
    vi.mocked(db.message.findMany).mockResolvedValue([
      {
        id: "msg-1",
        taskId: "task-1",
        role: "user",
        content: "m1",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:01.000Z"),
      },
      {
        id: "msg-2",
        taskId: "task-1",
        role: "user",
        content: "m2",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:02.000Z"),
      },
      {
        id: "msg-3",
        taskId: "task-1",
        role: "assistant",
        content: "m3",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:03.000Z"),
      },
      {
        id: "msg-4",
        taskId: "task-1",
        role: "assistant",
        content: "m4",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:04.000Z"),
      },
    ] as any);

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:6152/api/tasks/task-1/messages?limit=2",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.message.findMany).toHaveBeenCalledWith(
      {
        where: { taskId: "task-1" },
        orderBy: { createdAt: "asc" },
      },
    );
    expect(Array.isArray(data)).toBe(true);
    expect(data.map((message: { id: string }) => message.id)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
  });

  it("keeps default array mode unpaginated even when history exceeds 50 messages", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-compat-1",
      projectId: "proj-1",
      taskType: "ai_task",
    } as any);
    vi.mocked(db.message.findMany).mockResolvedValue(
      Array.from({ length: 55 }, (_, index) => ({
        id: `msg-${index + 1}`,
        taskId: "task-compat-1",
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index + 1}`,
        metadata: null,
        createdAt: new Date(`2026-03-23T00:00:${String(index).padStart(2, "0")}.000Z`),
      })) as any,
    );

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:6152/api/tasks/task-compat-1/messages",
      }),
      { params: Promise.resolve({ taskId: "task-compat-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(55);
    expect(data[0]).toMatchObject({ id: "msg-1" });
    expect(data[54]).toMatchObject({ id: "msg-55" });
  });

  it("returns paginated message envelope when explicitly requested", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
    } as any);
    vi.mocked(db.message.findMany).mockResolvedValue([
      {
        id: "msg-4",
        taskId: "task-1",
        role: "assistant",
        content: "m4",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:04.000Z"),
      },
      {
        id: "msg-3",
        taskId: "task-1",
        role: "assistant",
        content: "m3",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:03.000Z"),
      },
      {
        id: "msg-2",
        taskId: "task-1",
        role: "user",
        content: "m2",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:02.000Z"),
      },
    ] as any);

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:6152/api/tasks/task-1/messages?limit=2&pagination=1",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.pagination).toEqual({
      has_more_before: true,
      oldest_message_id: "msg-3",
      page_size: 2,
    });
    expect(data.messages.map((message: { id: string }) => message.id)).toEqual(["msg-3", "msg-4"]);
  });

  it("returns older paginated page before a cursor id", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
    } as any);
    vi.mocked(db.message.findFirst).mockResolvedValue({
      id: "msg-3",
      createdAt: new Date("2026-03-23T00:00:03.000Z"),
    } as any);
    vi.mocked(db.message.findMany).mockResolvedValue([
      {
        id: "msg-2",
        taskId: "task-1",
        role: "assistant",
        content: "m2",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:02.000Z"),
      },
      {
        id: "msg-1",
        taskId: "task-1",
        role: "user",
        content: "m1",
        metadata: null,
        createdAt: new Date("2026-03-23T00:00:01.000Z"),
      },
    ] as any);

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:6152/api/tasks/task-1/messages?limit=2&before_id=msg-3&pagination=1",
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.message.findFirst).toHaveBeenCalledWith({
      where: { id: "msg-3", taskId: "task-1" },
      select: {
        id: true,
        createdAt: true,
      },
    });
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskId: "task-1",
          OR: [
            { createdAt: { lt: new Date("2026-03-23T00:00:03.000Z") } },
            { createdAt: new Date("2026-03-23T00:00:03.000Z"), id: { lt: "msg-3" } },
          ],
        },
      }),
    );
    expect(data.pagination).toEqual({
      has_more_before: false,
      oldest_message_id: "msg-1",
      page_size: 2,
    });
    expect(data.messages.map((message: { id: string }) => message.id)).toEqual(["msg-1", "msg-2"]);
  });
});
