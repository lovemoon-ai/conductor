import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/achieve/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcast: vi.fn(),
  },
}));

vi.mock("@/lib/tasks/teardown", () => ({
  teardownTaskRuntime: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return { ...mod, checkAndUpdateExpiredSubscription: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { teardownTaskRuntime } = await import("@/lib/tasks/teardown");

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

const achievableTask = {
  id: "ai-1",
  projectId: "proj-1",
  taskType: "ai_task",
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  status: "completed",
  launchConfig: null,
  metadata: null,
  achievedAt: null,
  project: { daemonHost: "daemon-a" },
};

const callAchieve = async (taskId = "ai-1") =>
  POST(
    createMockRequest({
      method: "POST",
      url: `http://localhost:6152/api/tasks/${taskId}/achieve`,
      body: {},
      token: createTestToken(ACTIVE_USER.id),
    }),
    { params: Promise.resolve({ taskId }) },
  );

describe("POST /api/tasks/[taskId]/achieve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: ACTIVE_USER.id,
      email: ACTIVE_USER.email,
      phone: ACTIVE_USER.phone,
    } as any);
    vi.mocked(db.user.findUnique).mockResolvedValue(ACTIVE_USER as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(achievableTask as any);
    vi.mocked(teardownTaskRuntime).mockResolvedValue({ ok: true } as any);
  });

  it("tears down runtime, stamps achievedAt, and preserves the transcript", async () => {
    const res = await callAchieve();
    expect(res.status).toBe(200);

    // Runtime is torn down but attachments are preserved (transcript may link them).
    expect(teardownTaskRuntime).toHaveBeenCalledTimes(1);
    expect(vi.mocked(teardownTaskRuntime).mock.calls[0][0]).toMatchObject({
      userId: "user-1",
      reason: "achieved_by_user",
      deleteAttachmentDirectory: false,
    });

    // achievedAt is committed atomically by teardown; the route itself does
    // not perform a second, race-prone task update.
    const teardownArgs = vi.mocked(teardownTaskRuntime).mock.calls[0][0] as any;
    expect(teardownArgs.archivePatch.achievedAt).toBeInstanceOf(Date);
    expect(db.task.update).not.toHaveBeenCalled();

    // Clients told to drop it from the active list.
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({ type: "task_achieved" }),
    );
  });

  it("forces a running task into killed so a later in-place un-pack succeeds", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...achievableTask,
      status: "running",
    } as any);

    const res = await callAchieve();
    expect(res.status).toBe(200);

    const archivePatch = (vi.mocked(teardownTaskRuntime).mock.calls[0][0] as any)
      .archivePatch;
    expect(archivePatch.achievedAt).toBeInstanceOf(Date);
    expect(archivePatch.status).toBe("killed");
    expect(archivePatch.killedReason).toBe("user_stopped");
    expect(archivePatch.killedAt).toBeInstanceOf(Date);
  });

  it("does not rewrite status when the task is already terminal", async () => {
    // achievableTask.status === "completed" (terminal)
    const res = await callAchieve();
    expect(res.status).toBe(200);
    const archivePatch = (vi.mocked(teardownTaskRuntime).mock.calls[0][0] as any)
      .archivePatch;
    expect(archivePatch.status).toBeUndefined();
    expect(archivePatch.killedReason).toBeUndefined();
  });

  it("is idempotent when the task is already achieved", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...achievableTask,
      achievedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as any);

    const res = await callAchieve();
    expect(res.status).toBe(200);
    expect(teardownTaskRuntime).not.toHaveBeenCalled();
    expect(db.task.update).not.toHaveBeenCalled();
  });

  it("does not stamp achievedAt when teardown fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(teardownTaskRuntime).mockResolvedValue({
      ok: false,
      status: 409,
      error: "boom",
    } as any);

    try {
      const res = await callAchieve();
      expect(res.status).toBe(409);
      expect(db.task.update).not.toHaveBeenCalled();
      expect(realtimeHub.broadcast).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "[task-achieve] teardown rejected",
        expect.objectContaining({ taskId: "ai-1", status: 409 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not classify an expired P2028 transaction as archive busy", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const expiredError = Object.assign(
      new Error("Transaction already closed: A query cannot be executed on an expired transaction."),
      { code: "P2028" },
    );
    vi.mocked(teardownTaskRuntime).mockRejectedValue(expiredError);

    try {
      await expect(callAchieve()).rejects.toBe(expiredError);
      expect(errorSpy).toHaveBeenCalledWith(
        "[task-achieve] teardown failed",
        expect.objectContaining({
          taskId: "ai-1",
          prismaCode: "P2028",
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns a retryable 503 when the archive transaction is busy", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(teardownTaskRuntime).mockRejectedValue(
      Object.assign(new Error("Unable to start a transaction in the given time"), {
        code: "P2028",
      }),
    );

    try {
      const res = await callAchieve();
      expect(res.status).toBe(503);
      expect(await extractJson(res)).toEqual({
        error: "Archive is temporarily busy; retry this task.",
        code: "archive_busy",
        retryable: true,
      });
      expect(realtimeHub.broadcast).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        "[task-achieve] transaction busy",
        expect.objectContaining({
          taskId: "ai-1",
          projectId: "proj-1",
          prismaCode: "P2028",
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns 404 for an unknown task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null);
    const res = await callAchieve("missing");
    expect(res.status).toBe(404);
  });
});
