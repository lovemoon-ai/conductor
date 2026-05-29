import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    agentOutbox: {
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { db } from "@/lib/db";
import { deliverAgentOutboxForHost } from "@/lib/realtime/agent-outbox";

describe("agent-outbox delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.agentOutbox.findMany).mockResolvedValue([] as any);
    vi.mocked(db.agentOutbox.update).mockResolvedValue({ id: "row-1" } as any);
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
});
