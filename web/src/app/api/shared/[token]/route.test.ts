import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/shared/[token]/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/db", () => ({
  db: {
    sharedTask: {
      findUnique: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");

const buildSharedTask = (overrides: Record<string, unknown> = {}) => ({
  id: "shared-1",
  taskId: "task-1",
  userId: "user-1",
  token: "test-token",
  expiresAt: null,
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  task: {
    id: "task-1",
    title: "Test Task",
    status: "completed",
    taskType: "ai_task",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  },
  ...overrides,
});

describe("/api/shared/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for invalid token", async () => {
    vi.mocked(db.sharedTask.findUnique).mockResolvedValue(null);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/bad-token" }),
      { params: Promise.resolve({ token: "bad-token" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(404);
    expect(data).toEqual({ error: "Not found" });
  });

  it("returns 410 for expired share link", async () => {
    vi.mocked(db.sharedTask.findUnique).mockResolvedValue(
      buildSharedTask({ expiresAt: new Date("2026-01-01T00:00:00.000Z") }) as any,
    );

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(410);
    expect(data).toEqual({ error: "This shared link has expired" });
  });

  it("returns task and messages for valid token", async () => {
    vi.mocked(db.sharedTask.findUnique).mockResolvedValue(buildSharedTask() as any);
    vi.mocked(db.message.findMany).mockResolvedValue([
      {
        id: "msg-1",
        taskId: "task-1",
        role: "user",
        content: "Hello",
        metadata: null,
        createdAt: new Date("2026-04-01T00:01:00.000Z"),
      },
      {
        id: "msg-2",
        taskId: "task-1",
        role: "assistant",
        content: "Hi there!",
        metadata: null,
        createdAt: new Date("2026-04-01T00:02:00.000Z"),
      },
    ] as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.task).toEqual({
      title: "Test Task",
      status: "completed",
      taskType: "ai_task",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]).toEqual({
      id: "msg-1",
      role: "user",
      content: "Hello",
      createdAt: "2026-04-01T00:01:00.000Z",
    });
    expect(data.messages[1]).toEqual({
      id: "msg-2",
      role: "assistant",
      content: "Hi there!",
      createdAt: "2026-04-01T00:02:00.000Z",
    });
  });

  it("does not include taskId or metadata in message response", async () => {
    vi.mocked(db.sharedTask.findUnique).mockResolvedValue(buildSharedTask() as any);
    vi.mocked(db.message.findMany).mockResolvedValue([
      {
        id: "msg-1",
        taskId: "task-1",
        role: "user",
        content: "secret context",
        metadata: JSON.stringify({ internal: true }),
        createdAt: new Date("2026-04-01T00:01:00.000Z"),
      },
    ] as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    const message = data.messages[0];
    expect(message).not.toHaveProperty("taskId");
    expect(message).not.toHaveProperty("metadata");
    expect(Object.keys(message).sort()).toEqual(["content", "createdAt", "id", "role"]);
  });

  it("limits messages to MAX_SHARED_MESSAGES", async () => {
    vi.mocked(db.sharedTask.findUnique).mockResolvedValue(buildSharedTask() as any);
    vi.mocked(db.message.findMany).mockResolvedValue([]);

    await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );

    expect(db.message.findMany).toHaveBeenCalledWith({
      where: { taskId: "task-1", role: { in: ["user", "assistant", "sdk"] } },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: { id: true, role: true, content: true, metadata: true, createdAt: true },
    });
  });

  it("filters out synthetic messages", async () => {
    vi.mocked(db.sharedTask.findUnique).mockResolvedValue(buildSharedTask() as any);
    vi.mocked(db.message.findMany).mockResolvedValue([
      {
        id: "msg-syn",
        role: "sdk",
        content: "aiden session started: abc-123 (model=aiden)",
        metadata: JSON.stringify({ synthetic: true, backend: "aiden" }),
        createdAt: new Date("2026-04-01T00:00:30.000Z"),
      },
      {
        id: "msg-user",
        role: "user",
        content: "hello",
        metadata: null,
        createdAt: new Date("2026-04-01T00:01:00.000Z"),
      },
      {
        id: "msg-reply",
        role: "sdk",
        content: "Hi there!",
        metadata: JSON.stringify({ backend: "aiden", reply_to: "msg-user" }),
        createdAt: new Date("2026-04-01T00:02:00.000Z"),
      },
    ] as any);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );
    const data = await extractJson(response);

    expect(data.messages).toHaveLength(2);
    expect(data.messages.map((m: { id: string }) => m.id)).toEqual(["msg-user", "msg-reply"]);
  });

  it("allows access without authentication", async () => {
    vi.mocked(db.sharedTask.findUnique).mockResolvedValue(buildSharedTask() as any);
    vi.mocked(db.message.findMany).mockResolvedValue([]);

    const response = await GET(
      createMockRequest({ url: "http://localhost:6152/api/shared/test-token" }),
      { params: Promise.resolve({ token: "test-token" }) },
    );

    expect(response.status).toBe(200);
  });
});
