import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/agent-request", () => ({ authenticateAgentRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    task: { findFirst: vi.fn() },
    taskAttachment: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/tasks/task-file-storage", () => ({ openTaskAttachmentStreamByStorageKey: vi.fn() }));
vi.mock("@/lib/tasks/attachment-transfer-token", () => ({ verifyAttachmentTransferToken: vi.fn(() => true) }));

const { authenticateAgentRequest } = await import("@/lib/auth/agent-request");
const { db } = await import("@/lib/db");
const { openTaskAttachmentStreamByStorageKey } = await import("@/lib/tasks/task-file-storage");
const { GET } = await import("./[taskId]/attachments/[attachmentId]/content/route");
const { POST } = await import("./[taskId]/messages/[messageId]/materialized/route");

const agentRequest = (url: string, init?: RequestInit) => new NextRequest(url, {
  ...init,
  headers: {
    authorization: "Bearer token",
    "x-conductor-host": "daemon-current",
    ...init?.headers,
  },
});

describe("agent task attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateAgentRequest).mockResolvedValue({
      user: { id: "user-1" }, agentHost: "daemon-current",
    } as any);
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-1" } as any);
  });

  it("downloads a bound attachment for the current execution host", async () => {
    vi.mocked(db.taskAttachment.findFirst).mockResolvedValue({
      id: "att-1", taskId: "task-1", messageId: "msg-1", storageKey: "att-1--diagram.png",
      originalName: "diagram.png", mimeType: "image/png", sha256: "a".repeat(64),
    } as any);
    const { Readable } = await import("node:stream");
    vi.mocked(openTaskAttachmentStreamByStorageKey).mockResolvedValue({
      stream: Readable.from(Buffer.from("image")) as any,
      sizeBytes: 5,
    });

    const response = await GET(agentRequest("http://localhost/api/agent/tasks/task-1/attachments/att-1/content"), {
      params: Promise.resolve({ taskId: "task-1", attachmentId: "att-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
    expect(db.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { executionHost: "daemon-current" },
          { executionHost: null, agentHost: "daemon-current" },
        ],
      }),
    }));
  });

  it("does not reveal attachments to an unauthorized host", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null);
    const response = await GET(agentRequest("http://localhost/api/agent/tasks/task-1/attachments/att-1/content"), {
      params: Promise.resolve({ taskId: "task-1", attachmentId: "att-1" }),
    });
    expect(response.status).toBe(404);
    expect(db.taskAttachment.findFirst).not.toHaveBeenCalled();
  });

  it("atomically verifies the complete materialization report before updating", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", sha256: "a".repeat(64) },
      { id: "att-2", sha256: "b".repeat(64) },
    ] as any);
    vi.mocked(db.taskAttachment.updateMany).mockResolvedValue({ count: 2 } as any);
    const response = await POST(agentRequest(
      "http://localhost/api/agent/tasks/task-1/messages/msg-1/materialized",
      {
        method: "POST",
        body: JSON.stringify({ attachments: [
          { id: "att-1", sha256: "a".repeat(64), status: "ready", transferToken: "one" },
          { id: "att-2", sha256: "b".repeat(64), status: "ready", transferToken: "two" },
        ] }),
      },
    ), { params: Promise.resolve({ taskId: "task-1", messageId: "msg-1" }) });

    expect(response.status).toBe(200);
    expect(db.taskAttachment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["att-1", "att-2"] }, taskId: "task-1", messageId: "msg-1" },
    }));
  });

  it("rejects the whole report without updates when one digest mismatches", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", sha256: "c".repeat(64) },
    ] as any);
    const response = await POST(agentRequest(
      "http://localhost/api/agent/tasks/task-1/messages/msg-1/materialized",
      { method: "POST", body: JSON.stringify({ attachments: [
        { id: "att-1", sha256: "a".repeat(64), status: "ready", transferToken: "one" },
      ] }) },
    ), { params: Promise.resolve({ taskId: "task-1", messageId: "msg-1" }) });

    expect(response.status).toBe(409);
    expect(db.taskAttachment.updateMany).not.toHaveBeenCalled();
  });
});
