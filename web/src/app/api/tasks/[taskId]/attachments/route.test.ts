import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/tasks/[taskId]/attachments/route";
import { GET as GET_ATTACHMENT } from "@/app/api/tasks/[taskId]/attachments/[attachmentId]/route";
import { extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({ getActiveSubscriptionUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    task: { findFirst: vi.fn() },
    taskAttachment: { create: vi.fn(), findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/tasks/task-file-storage", () => ({
  writeTaskAttachment: vi.fn(),
  openTaskAttachmentStreamByStorageKey: vi.fn(),
  deleteTaskAttachmentByStorageKey: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { db } = await import("@/lib/db");
const { writeTaskAttachment, openTaskAttachmentStreamByStorageKey, deleteTaskAttachmentByStorageKey } = await import("@/lib/tasks/task-file-storage");

describe("/api/tasks/[taskId]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteTaskAttachmentByStorageKey).mockResolvedValue(undefined);
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(db.task.findFirst).mockResolvedValue({ id: "task-1", achievedAt: null } as any);
  });

  it("uploads a staging attachment without creating a message", async () => {
    vi.mocked(writeTaskAttachment).mockResolvedValue({
      id: "att-1", name: "diagram.png", mimeType: "image/png", sizeBytes: 4, kind: "image",
      downloadUrl: "/api/tasks/task-1/attachments/att-1", storageKey: "att-1--diagram.png", sha256: "a".repeat(64),
    } as any);
    vi.mocked(db.taskAttachment.create).mockResolvedValue({
      id: "att-1", taskId: "task-1", originalName: "diagram.png", mimeType: "image/png", sizeBytes: 4,
      kind: "image", status: "uploaded", sha256: "a".repeat(64), createdAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-08-02T00:00:00Z"),
    } as any);

    const formData = new FormData();
    formData.set("file", new File(["data"], "diagram.png", { type: "image/png" }));
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/attachments", {
      method: "POST", body: formData,
    }), { params: Promise.resolve({ taskId: "task-1" }) });
    const data = await extractJson(response);

    expect(response.status).toBe(201);
    expect(data.attachment).toMatchObject({ id: "att-1", status: "uploaded", sha256: "a".repeat(64) });
    expect(db.taskAttachment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ taskId: "task-1", storageKey: "att-1--diagram.png" }),
    }));
  });

  it("rejects video before writing it", async () => {
    const formData = new FormData();
    formData.set("file", new File(["video"], "clip.mp4", { type: "video/mp4" }));
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/attachments", {
      method: "POST", body: formData,
    }), { params: Promise.resolve({ taskId: "task-1" }) });
    expect(response.status).toBe(415);
    expect(writeTaskAttachment).not.toHaveBeenCalled();
  });

  it("rejects a video extension even when the browser omits its MIME type", async () => {
    const formData = new FormData();
    formData.set("file", new File(["video"], "clip.mkv"));
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/attachments", {
      method: "POST", body: formData,
    }), { params: Promise.resolve({ taskId: "task-1" }) });
    expect(response.status).toBe(415);
    expect(writeTaskAttachment).not.toHaveBeenCalled();
  });

  it("removes the staged file when its database record cannot be created", async () => {
    vi.mocked(writeTaskAttachment).mockResolvedValue({
      id: "att-orphan", name: "notes.txt", mimeType: "text/plain", sizeBytes: 4, kind: "file",
      downloadUrl: "/api/tasks/task-1/attachments/att-orphan", storageKey: "att-orphan--notes.txt", sha256: "b".repeat(64),
    } as any);
    vi.mocked(db.taskAttachment.create).mockRejectedValue(new Error("database unavailable"));
    const formData = new FormData();
    formData.set("file", new File(["data"], "notes.txt", { type: "text/plain" }));

    await expect(POST(new NextRequest("http://localhost/api/tasks/task-1/attachments", {
      method: "POST", body: formData,
    }), { params: Promise.resolve({ taskId: "task-1" }) })).rejects.toThrow("database unavailable");

    expect(deleteTaskAttachmentByStorageKey).toHaveBeenCalledWith("task-1", "att-orphan--notes.txt");
  });

  it("streams a stored attachment back to an authenticated user", async () => {
    vi.mocked(db.taskAttachment.findFirst).mockResolvedValue({
      id: "att-1", taskId: "task-1", originalName: "diagram.png", mimeType: "image/png",
      storageKey: "att-1--diagram.png", sha256: "a".repeat(64),
    } as any);
    const { Readable } = await import("node:stream");
    vi.mocked(openTaskAttachmentStreamByStorageKey).mockResolvedValue({
      stream: Readable.from(Buffer.from("data")) as any,
      sizeBytes: 4,
    });
    const response = await GET_ATTACHMENT(
      new NextRequest("http://localhost/api/tasks/task-1/attachments/att-1"),
      { params: Promise.resolve({ taskId: "task-1", attachmentId: "att-1" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(`"${"a".repeat(64)}"`);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("data");
  });
});
