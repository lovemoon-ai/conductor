import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/tasks/[taskId]/messages/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;

      constructor(message: string, options: { code?: string } = {}) {
        super(message);
        this.code = options.code || "UNKNOWN";
      }
    },
  },
}));

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
      findUniqueOrThrow: vi.fn(),
    },
    taskRuntimeState: {
      findUnique: vi.fn(),
    },
    agentOutbox: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/tasks/persistent-round", () => ({
  startPersistentRound: vi.fn(),
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

// Partial-mock the ingress service so the audit-strip test (M-NEW-1) can
// inspect the metadata that crosses the persistence boundary, while the
// existing tests keep using the real `appendUserMessageToTask` runtime
// checks (e.g. "missing fire owner" → 409).
vi.mock("@/lib/channel/task-ingress-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/channel/task-ingress-service")>();
  return {
    ...original,
    appendUserMessageToTask: vi.fn(original.appendUserMessageToTask),
  };
});

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");
const { appendUserMessageToTask } = await import("@/lib/channel/task-ingress-service");
const { startPersistentRound } = await import("@/lib/tasks/persistent-round");

const endedPersistentTask = {
  id: "task-p",
  projectId: "proj-1",
  taskType: "ai_task",
  metadata: JSON.stringify({
    persistent: { enabled: true, round: 2, roundEndedAt: "2026-09-30T00:00:00.000Z" },
  }),
};

const postMessage = (body: Record<string, unknown>) =>
  POST(
    createMockRequest({
      method: "POST",
      url: "http://localhost:6152/api/tasks/task-p/messages",
      body,
    }),
    { params: Promise.resolve({ taskId: "task-p" }) },
  );

describe("/api/tasks/[taskId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.agentOutbox.findFirst).mockResolvedValue(null);
    vi.mocked(db.taskRuntimeState.findUnique).mockResolvedValue(null);
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  it("starts a new round when a user message reaches an ended persistent round", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(endedPersistentTask as any);
    vi.mocked(startPersistentRound).mockResolvedValue({ ok: true, task: {} as any, messageId: "msg-r3" });
    vi.mocked(db.message.findUniqueOrThrow).mockResolvedValue({
      id: "msg-r3",
      taskId: "task-p",
      role: "user",
      content: "next round",
      metadata: null,
      createdAt: new Date("2026-09-30T00:01:00.000Z"),
    } as any);

    const response = await postMessage({ content: "next round", role: "user" });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(startPersistentRound).toHaveBeenCalledWith({
      userId: "user-1",
      taskId: "task-p",
      content: "next round",
      messageMetadata: null,
      clientMessageId: null,
    });
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
    expect(data).toMatchObject({ id: "msg-r3", content: "next round" });
  });

  it("surfaces a failed round start and never appends to the ended round", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(endedPersistentTask as any);
    vi.mocked(startPersistentRound).mockResolvedValue({ ok: false, status: 409, error: "Daemon mac-mini is offline" });

    const response = await postMessage({ content: "next round", role: "user" });

    expect(response.status).toBe(409);
    expect(await extractJson(response)).toEqual({ error: "Daemon mac-mini is offline" });
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
  });

  it("records the clientRequestId on the new round's first message so a retry dedupes", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(endedPersistentTask as any);
    vi.mocked(db.message.findMany).mockResolvedValue([]);
    vi.mocked(startPersistentRound).mockResolvedValue({ ok: true, task: {} as any, messageId: "msg-r3" });
    vi.mocked(db.message.findUniqueOrThrow).mockResolvedValue({
      id: "msg-r3", taskId: "task-p", role: "user", content: "next", metadata: null, createdAt: new Date(),
    } as any);

    const response = await postMessage({ content: "next", role: "user", clientRequestId: "req-1" });

    expect(response.status).toBe(200);
    expect(startPersistentRound).toHaveBeenCalledWith(expect.objectContaining({
      messageMetadata: { clientRequestId: "req-1" },
      clientMessageId: "req-1",
    }));
  });

  it.each([
    ["a persistent task whose round the first attempt started", "init", endedPersistentTask.metadata],
    ["a task that stopped after the first attempt", "killed", null],
  ])("returns the stored message to a retry on %s instead of applying the send rules", async (_label, status, metadata) => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ ...endedPersistentTask, status, metadata } as any);
    // Beyond the route's recent-metadata scan: only the clientMessageId column finds it.
    vi.mocked(db.message.findMany).mockResolvedValue([]);
    vi.mocked(db.message.findFirst).mockResolvedValue({
      id: "msg-r3", taskId: "task-p", role: "user", content: "next", metadata: null, createdAt: new Date(),
    } as any);

    const response = await postMessage({ content: "next", role: "user", clientRequestId: "req-1" });

    expect(response.status).toBe(200);
    expect(await extractJson(response)).toMatchObject({ id: "msg-r3" });
    expect(db.message.findFirst).toHaveBeenCalledWith({ where: { taskId: "task-p", clientMessageId: "req-1" } });
    expect(startPersistentRound).not.toHaveBeenCalled();
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
  });

  describe("while the end-of-round summary is pending", () => {
    const summaryPendingTask = {
      ...endedPersistentTask,
      status: "running",
      metadata: JSON.stringify({
        persistent: {
          enabled: true,
          round: 2,
          roundEndedAt: "2026-09-30T00:00:00.000Z",
          roundEndMessageId: "msg-end",
        },
      }),
    };

    it("rejects the message instead of cutting the summary off", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(summaryPendingTask as any);
      vi.mocked(db.message.findMany).mockResolvedValue([]);

      const response = await postMessage({ content: "next round", role: "user" });

      expect(response.status).toBe(409);
      expect(await extractJson(response)).toMatchObject({ error: "round_summary_pending" });
      expect(startPersistentRound).not.toHaveBeenCalled();
      expect(appendUserMessageToTask).not.toHaveBeenCalled();
    });

    it("rejects the message while the summary reply is still streaming", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(summaryPendingTask as any);
      vi.mocked(db.taskRuntimeState.findUnique).mockResolvedValue({ replyInProgress: true, replyTo: "msg-end" } as any);

      const response = await postMessage({ content: "next round", role: "user" });

      expect(response.status).toBe(409);
      expect(startPersistentRound).not.toHaveBeenCalled();
    });

    it("starts the next round once the summary reply has landed", async () => {
      vi.mocked(db.task.findFirst).mockResolvedValue(summaryPendingTask as any);
      vi.mocked(db.taskRuntimeState.findUnique).mockResolvedValue(null);
      vi.mocked(db.message.findMany).mockResolvedValue([
        { metadata: JSON.stringify({ reply_to: "msg-end" }) },
      ] as any);
      vi.mocked(startPersistentRound).mockResolvedValue({ ok: false, status: 409, error: "Daemon mac-mini is offline" });

      await postMessage({ content: "next round", role: "user" });

      expect(startPersistentRound).toHaveBeenCalled();
    });
  });

  it.each(["completed", "killed", "unknown"])(
    "starts a new round when the persistent session is gone (status %s) without End round",
    async (status) => {
      vi.mocked(db.task.findFirst).mockResolvedValue({
        ...endedPersistentTask,
        status,
        metadata: JSON.stringify({ persistent: { enabled: true, round: 2 } }),
      } as any);
      vi.mocked(startPersistentRound).mockResolvedValue({ ok: false, status: 409, error: "Daemon mac-mini is offline" });

      await postMessage({ content: "next round", role: "user" });

      expect(startPersistentRound).toHaveBeenCalled();
      expect(appendUserMessageToTask).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "killed"])("rejects a user message to a %s non-persistent task", async (status) => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-p", projectId: "proj-1", taskType: "ai_task", status } as any);

    const response = await postMessage({ content: "hello", role: "user" });

    expect(response.status).toBe(409);
    expect(await extractJson(response)).toEqual({
      error: "task_not_running",
      message: "Only running ai_task accepts new messages",
    });
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
  });

  it("rejects a user message while a session refresh is in progress", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-p", projectId: "proj-1", taskType: "ai_task", status: "running" } as any);
    vi.mocked(db.agentOutbox.findFirst).mockResolvedValue({ requestId: "req-refresh" } as any);

    const response = await postMessage({ content: "hello", role: "user" });

    expect(response.status).toBe(409);
    expect(await extractJson(response)).toMatchObject({ error: "restart_pending" });
    expect(appendUserMessageToTask).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only content", async () => {
    const response = await postMessage({ content: "  \n ", role: "user" });

    expect(response.status).toBe(400);
    expect(db.task.findFirst).not.toHaveBeenCalled();
  });

  it("keeps non-user messages (the fire's own output) in the ended round", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(endedPersistentTask as any);
    vi.mocked(appendUserMessageToTask).mockResolvedValueOnce({ task: null, message: {
      id: "msg-sdk",
      taskId: "task-p",
      role: "sdk",
      content: "summary",
      metadata: null,
      createdAt: new Date(),
    } } as any);

    const response = await postMessage({ content: "summary", role: "sdk" });

    expect(response.status).toBe(200);
    expect(startPersistentRound).not.toHaveBeenCalled();
    expect(appendUserMessageToTask).toHaveBeenCalled();
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

  it("rejects POST user messages when the ai task has no runtime fire owner", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      taskType: "ai_task",
      agentHost: "daemon-a",
      executionHost: null,
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-stale");

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-1/messages",
        body: { content: "hello", role: "user" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      // Stable machine code so the web client can detect this transient startup
      // race and auto-retry instead of dropping the user's first message.
      code: "task_missing_active_fire_owner",
      error: "Task missing active fire owner",
      message: "The task is not connected to an active fire owner. Try again after it reconnects.",
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

  it("strips top-level audit-shaped keys before persisting metadata (review M3 / M-NEW-1)", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-strip",
      projectId: "proj-1",
      taskType: "ai_task",
    } as any);
    // Stub the ingress for just this test so we don't have to also mock the
    // `db.$transaction` / `realtimeHub` plumbing the real implementation
    // exercises. The original is restored automatically by `clearAllMocks`
    // in `beforeEach` so other tests still see the real runtime checks.
    vi.mocked(appendUserMessageToTask).mockResolvedValueOnce({
      task: { id: "task-strip", projectId: "proj-1" } as any,
      message: {
        id: "msg-strip",
        taskId: "task-strip",
        role: "sdk",
        content: "hello",
        metadata: JSON.stringify({ audit: { actor: "cli" }, custom: "kept" }),
        createdAt: new Date("2026-03-23T00:00:01.000Z"),
      } as any,
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-strip/messages",
        body: {
          content: "hello",
          metadata: {
            audit: { actor: "cli" },
            // Caller tries to spoof at the top level. Server must drop these.
            actor: "system",
            cliVersion: "fake",
            sdkVersion: "fake",
            invokedBy: "attacker",
            custom: "kept",
          },
        },
      }),
      { params: Promise.resolve({ taskId: "task-strip" }) },
    );

    expect(response.status).toBe(200);
    // Inspect what reached the ingress service (the persistence boundary).
    expect(appendUserMessageToTask).toHaveBeenCalledTimes(1);
    const call = vi.mocked(appendUserMessageToTask).mock.calls[0]?.[0] as {
      metadata: Record<string, unknown> | null;
    };
    expect(call.metadata).toEqual({
      audit: { actor: "cli" },
      custom: "kept",
    });
    expect(call.metadata?.actor).toBeUndefined();
    expect(call.metadata?.cliVersion).toBeUndefined();
    expect(call.metadata?.sdkVersion).toBeUndefined();
    expect(call.metadata?.invokedBy).toBeUndefined();
  });

  it("forwards ordered attachment IDs to the ingress service", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-files", projectId: "proj-1", taskType: "ai_task" } as any);
    vi.mocked(appendUserMessageToTask).mockResolvedValueOnce({
      task: { id: "task-files", projectId: "proj-1" } as any,
      message: {
        id: "msg-files", taskId: "task-files", role: "user", content: "inspect", metadata: null,
        createdAt: new Date("2026-08-01T00:00:00Z"),
      } as any,
    });

    const response = await POST(createMockRequest({
      method: "POST",
      url: "http://localhost:6152/api/tasks/task-files/messages",
      body: { content: "inspect", role: "user", attachmentIds: ["att-2", "att-1"] },
    }), { params: Promise.resolve({ taskId: "task-files" }) });

    expect(response.status).toBe(200);
    expect(appendUserMessageToTask).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: ["att-2", "att-1"],
    }));
  });

  it.each(["/compact keep the API decisions", "/clear"])("delivers the slash command %j to the task verbatim so fire can run it", async (content) => {
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-compact", projectId: "proj-1", taskType: "ai_task" } as any);
    vi.mocked(appendUserMessageToTask).mockResolvedValueOnce({
      task: { id: "task-compact", projectId: "proj-1" } as any,
      message: {
        id: "msg-compact", taskId: "task-compact", role: "user", content, metadata: null,
        createdAt: new Date("2026-09-18T00:00:00Z"),
      } as any,
    });

    const response = await POST(createMockRequest({
      method: "POST",
      url: "http://localhost:6152/api/tasks/task-compact/messages",
      body: { content, role: "user" },
    }), { params: Promise.resolve({ taskId: "task-compact" }) });

    expect(response.status).toBe(200);
    expect(appendUserMessageToTask).toHaveBeenCalledWith(expect.objectContaining({ content, role: "user" }));
  });

  it("returns existing message without re-creating when clientRequestId already exists", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-cri",
      projectId: "proj-1",
      taskType: "ai_task",
    } as any);
    vi.mocked(db.message.findMany).mockResolvedValueOnce([
      {
        id: "msg-prev",
        taskId: "task-cri",
        role: "sdk",
        content: "first delivery",
        metadata: JSON.stringify({
          clientRequestId: "send-1",
          audit: { actor: "cli" },
        }),
        createdAt: new Date("2026-03-23T00:00:01.000Z"),
      },
    ] as any);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:6152/api/tasks/task-cri/messages",
        body: {
          content: "second attempt",
          clientRequestId: "send-1",
        },
      }),
      { params: Promise.resolve({ taskId: "task-cri" }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ id: "msg-prev", content: "first delivery" });
    expect(db.message.create).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
    // Idempotency scan must be bounded — review H3 (no full-table fetch).
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: "task-cri" },
        orderBy: { createdAt: "desc" },
        take: expect.any(Number),
      }),
    );
    const call = vi.mocked(db.message.findMany).mock.calls[0]?.[0] as { take: number };
    expect(call.take).toBeGreaterThan(0);
    expect(call.take).toBeLessThanOrEqual(500);
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
