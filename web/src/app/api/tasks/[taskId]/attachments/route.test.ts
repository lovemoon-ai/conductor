import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/tasks/[taskId]/attachments/route";
import { GET as GET_ATTACHMENT } from "@/app/api/tasks/[taskId]/attachments/[attachmentId]/route";
import { extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
    task: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    getTaskAgentHost: vi.fn().mockReturnValue(null),
    sendToAgentHost: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("@/lib/realtime/agent-outbox", () => ({
  enqueueAndAttemptAgentCommand: vi.fn().mockResolvedValue({ delivered: false }),
}));

vi.mock("@/lib/tasks/task-file-storage", () => ({
  writeTaskAttachment: vi.fn(),
  readTaskAttachment: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { enqueueAndAttemptAgentCommand } = await import("@/lib/realtime/agent-outbox");
const { writeTaskAttachment, readTaskAttachment } = await import("@/lib/tasks/task-file-storage");

describe("/api/tasks/[taskId]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.$transaction).mockImplementation(async (operations: any) => {
      if (Array.isArray(operations)) {
        return Promise.all(operations);
      }
      return operations;
    });
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      agentHost: null,
      executionHost: null,
    } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: "task-1",
      updatedAt: new Date("2026-03-10T12:00:00.000Z"),
    } as any);
  });

  it("uploads a task attachment as sdk message", async () => {
    const attachment = {
      id: "att-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
      kind: "image",
      downloadUrl: "/api/tasks/task-1/attachments/att-1",
    };
    vi.mocked(writeTaskAttachment).mockResolvedValue(attachment as any);
    vi.mocked(db.message.create).mockResolvedValue({
      id: "msg-1",
      taskId: "task-1",
      role: "sdk",
      content: "Attached file: diagram.png",
      metadata: JSON.stringify({ attachments: [attachment] }),
      createdAt: new Date("2026-03-10T12:00:00.000Z"),
    } as any);

    const formData = new FormData();
    formData.set("file", new File(["data"], "diagram.png", { type: "image/png" }));
    const request = new NextRequest("http://localhost:6152/api/tasks/task-1/attachments", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request, {
      params: Promise.resolve({ taskId: "task-1" }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(writeTaskAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        fileName: "diagram.png",
        mimeType: "image/png",
      }),
    );
    expect(data.attachments).toEqual([attachment]);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({
          updatedAt: expect.any(Date),
        }),
      }),
    );
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_sdk_message",
        payload: expect.objectContaining({
          id: "msg-1",
          attachments: [attachment],
        }),
      }),
    );
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("routes user attachments to the runtime fire owner instead of a stale bound fire host", async () => {
    const attachment = {
      id: "att-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
      kind: "image",
      downloadUrl: "/api/tasks/task-1/attachments/att-1",
    };
    vi.mocked(writeTaskAttachment).mockResolvedValue(attachment as any);
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      agentHost: "daemon-a",
      executionHost: "conductor-fire-runtime",
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-stale");
    vi.mocked(db.message.create).mockResolvedValue({
      id: "msg-1",
      taskId: "task-1",
      role: "user",
      content: "see attached",
      metadata: JSON.stringify({ attachments: [attachment] }),
      createdAt: new Date("2026-03-10T12:00:00.000Z"),
    } as any);

    const formData = new FormData();
    formData.set("file", new File(["data"], "diagram.png", { type: "image/png" }));
    formData.set("role", "user");
    formData.set("content", "see attached");
    const request = new NextRequest("http://localhost:6152/api/tasks/task-1/attachments", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request, {
      params: Promise.resolve({ taskId: "task-1" }),
    });

    expect(response.status).toBe(200);
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.objectContaining({
        type: "task_user_message",
      }),
    );
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHost: "conductor-fire-runtime",
        eventType: "task_user_message",
      }),
      expect.objectContaining({
        agentHost: "conductor-fire-runtime",
      }),
    );
  });

  it("rejects user attachments without a runtime fire owner", async () => {
    const attachment = {
      id: "att-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
      kind: "image",
      downloadUrl: "/api/tasks/task-1/attachments/att-1",
    };
    vi.mocked(writeTaskAttachment).mockResolvedValue(attachment as any);
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: "task-1",
      projectId: "proj-1",
      agentHost: "daemon-a",
      executionHost: null,
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue("conductor-fire-stale");
    vi.mocked(db.message.create).mockResolvedValue({
      id: "msg-1",
      taskId: "task-1",
      role: "user",
      content: "see attached",
      metadata: JSON.stringify({ attachments: [attachment] }),
      createdAt: new Date("2026-03-10T12:00:00.000Z"),
    } as any);

    const formData = new FormData();
    formData.set("file", new File(["data"], "diagram.png", { type: "image/png" }));
    formData.set("role", "user");
    formData.set("content", "see attached");
    const request = new NextRequest("http://localhost:6152/api/tasks/task-1/attachments", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request, {
      params: Promise.resolve({ taskId: "task-1" }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({
      error: "Task missing active fire owner",
      message: "The task is not connected to an active fire owner. Try again after it reconnects.",
    });
    expect(writeTaskAttachment).not.toHaveBeenCalled();
    expect(db.message.create).not.toHaveBeenCalled();
    expect(db.task.update).not.toHaveBeenCalled();
    expect(realtimeHub.broadcast).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it("streams a stored attachment back to an authenticated user", async () => {
    const attachment = {
      id: "att-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
      kind: "image",
      downloadUrl: "/api/tasks/task-1/attachments/att-1",
    };
    vi.mocked(db.message.findMany).mockResolvedValue([
      { metadata: JSON.stringify({ attachments: [attachment] }) },
    ] as any);
    vi.mocked(readTaskAttachment).mockResolvedValue(Buffer.from("data"));

    const request = new NextRequest("http://localhost:6152/api/tasks/task-1/attachments/att-1");
    const response = await GET_ATTACHMENT(request, {
      params: Promise.resolve({ taskId: "task-1", attachmentId: "att-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe("data");
  });
});
