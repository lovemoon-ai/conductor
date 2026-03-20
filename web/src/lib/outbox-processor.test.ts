import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    agentOutbox: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    deadLetterQueue: {
      count: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    hasAgentHost: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import { outboxProcessor } from "@/lib/outbox-processor";
import { realtimeHub } from "@/lib/realtime/hub";

const buildPendingMessage = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "msg-1",
  userId: "user-1",
  agentHost: "m1",
  taskId: "task-1",
  eventType: "task_user_message",
  requestId: "req-1",
  payloadJson: "{\"type\":\"task_user_message\"}",
  status: "pending",
  attemptCount: 1,
  maxAttempts: 20,
  ttlHours: 24,
  expiresAt: new Date(Date.now() + 60_000),
  nextRetryAt: null,
  lastError: null,
  sentAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("outboxProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(db.agentOutbox.updateMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(db.agentOutbox.findMany).mockResolvedValue([] as any);
    vi.mocked(db.agentOutbox.update).mockResolvedValue({ id: "msg-1" } as any);
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(false);
  });

  it("retries pending messages when assigned host is not connected in realtime hub", async () => {
    vi.mocked(db.agentOutbox.findMany)
      .mockResolvedValueOnce([buildPendingMessage()] as any)
      .mockResolvedValueOnce([] as any);

    const result = await outboxProcessor.processPendingMessages();

    expect(realtimeHub.hasAgentHost).toHaveBeenCalledWith("m1", "user-1");
    expect(db.agentOutbox.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: {
        attemptCount: { increment: 1 },
        nextRetryAt: expect.any(Date),
        lastError: "Agent offline",
        updatedAt: expect.any(Date),
      },
    });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("treats realtime hub presence as online even without heartbeat manager state", async () => {
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);
    vi.mocked(db.agentOutbox.findMany)
      .mockResolvedValueOnce([buildPendingMessage({ id: "msg-2" })] as any)
      .mockResolvedValueOnce([] as any);

    const result = await outboxProcessor.processPendingMessages();

    expect(realtimeHub.hasAgentHost).toHaveBeenCalledWith("m1", "user-1");
    expect(db.agentOutbox.update).toHaveBeenCalledWith({
      where: { id: "msg-2" },
      data: {
        status: "sent",
        sentAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("marks pending messages failed only after a real disconnect with no active host", async () => {
    vi.mocked(db.agentOutbox.updateMany).mockResolvedValueOnce({ count: 2 } as any);

    const count = await outboxProcessor.handleDisconnectedAgent("m1", "user-1");

    expect(realtimeHub.hasAgentHost).toHaveBeenCalledWith("m1", "user-1");
    expect(db.agentOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        agentHost: "m1",
        userId: "user-1",
        status: "pending",
        attemptCount: { gte: 3 },
      },
      data: {
        status: "failed",
        lastError: "Agent host offline: m1",
        updatedAt: expect.any(Date),
      },
    });
    expect(count).toBe(2);
  });

  it("does not fail pending messages after disconnect if the host has already reconnected", async () => {
    vi.mocked(realtimeHub.hasAgentHost).mockReturnValue(true);

    const count = await outboxProcessor.handleDisconnectedAgent("m1", "user-1");

    expect(db.agentOutbox.updateMany).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});
