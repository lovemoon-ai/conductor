import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    agentOutbox: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { db } from "@/lib/db";
import {
  deliverAgentOutboxForHost,
  enqueueAndAttemptAgentCommand,
} from "@/lib/realtime/agent-outbox";

describe("agent-outbox delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.agentOutbox.findMany).mockResolvedValue([] as any);
    vi.mocked(db.agentOutbox.findUnique).mockResolvedValue(null as any);
    vi.mocked(db.agentOutbox.update).mockResolvedValue({ id: "row-1" } as any);
    vi.mocked(db.agentOutbox.create).mockResolvedValue({
      id: "row-1",
      userId: "user-1",
      agentHost: "fire-1",
      taskId: "task-1",
      eventType: "task_user_message",
      requestId: "req-1",
      createdAt: new Date("2026-03-10T10:00:00.000Z"),
      payloadJson: JSON.stringify({
        type: "task_user_message",
        payload: { request_id: "req-1" },
      }),
    } as any);
  });

  it("injects delivery cursor into replayed payloads", async () => {
    vi.mocked(db.agentOutbox.findMany).mockResolvedValue([
      {
        id: "row-2",
        userId: "user-1",
        agentHost: "fire-1",
        taskId: "task-1",
        eventType: "task_user_message",
        requestId: "req-2",
        createdAt: new Date("2026-03-10T10:00:01.000Z"),
        payloadJson: JSON.stringify({
          type: "task_user_message",
          payload: {
            task_id: "task-1",
            project_id: "proj-1",
            request_id: "req-2",
            content: "newer",
          },
        }),
      },
    ] as any);

    const deliveredPayloads: Array<Record<string, unknown>> = [];
    const result = await deliverAgentOutboxForHost({
      userId: "user-1",
      agentHost: "fire-1",
      sendToAgentHost: ({ envelope }) => {
        deliveredPayloads.push(envelope);
        return true;
      },
    });

    expect(result).toEqual({ attempted: 1, delivered: 1 });
    expect(deliveredPayloads).toEqual([
      {
        type: "task_user_message",
        payload: expect.objectContaining({
          request_id: "req-2",
          content: "newer",
          delivery_cursor: {
            createdAt: "2026-03-10T10:00:01.000Z",
            requestId: "req-2",
          },
        }),
      },
    ]);
  });

  it("can ignore nextRetryAt when forcing a reconnect replay", async () => {
    vi.mocked(db.agentOutbox.findMany).mockResolvedValue([] as any);

    await deliverAgentOutboxForHost({
      userId: "user-1",
      agentHost: "fire-1",
      ignoreRetryAt: true,
      sendToAgentHost: () => true,
    });

    expect(db.agentOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          status: { in: ["pending", "sent"] },
          AND: [{ OR: [{ agentHost: "fire-1" }, { agentHost: null }] }],
        },
      }),
    );
  });

  it("prioritizes fresh pending commands before sent retry cleanup", async () => {
    await deliverAgentOutboxForHost({
      userId: "user-1",
      agentHost: "m1",
      sendToAgentHost: () => true,
    });

    expect(db.agentOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ status: "asc" }, { createdAt: "asc" }, { requestId: "asc" }],
      }),
    );
  });

  it("reuses an existing outbox row when enqueue sees the same request id", async () => {
    vi.mocked(db.agentOutbox.create).mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    vi.mocked(db.agentOutbox.findUnique).mockResolvedValue({
      id: "row-existing",
      userId: "user-1",
      agentHost: "fire-1",
      taskId: "task-1",
      eventType: "task_user_message",
      requestId: "req-existing",
      createdAt: new Date("2026-03-10T10:00:00.000Z"),
      payloadJson: JSON.stringify({
        type: "task_user_message",
        payload: {
          request_id: "req-existing",
          task_id: "task-1",
          content: "scheduled retry",
        },
      }),
    } as any);

    const deliveredPayloads: Array<Record<string, unknown>> = [];
    const result = await enqueueAndAttemptAgentCommand(
      {
        userId: "user-1",
        agentHost: "fire-1",
        taskId: "task-1",
        eventType: "task_user_message",
        requestId: "req-existing",
        envelope: {
          type: "task_user_message",
          payload: { request_id: "req-existing" },
        },
      },
      {
        agentHost: "fire-1",
        sendToAgentHost: ({ envelope }) => {
          deliveredPayloads.push(envelope);
          return true;
        },
      },
    );

    expect(result).toEqual({ requestId: "req-existing", delivered: true });
    expect(db.agentOutbox.findUnique).toHaveBeenCalledWith({
      where: { requestId: "req-existing" },
    });
    expect(deliveredPayloads).toEqual([
      {
        type: "task_user_message",
        payload: expect.objectContaining({
          request_id: "req-existing",
          content: "scheduled retry",
        }),
      },
    ]);
  });
});
