import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    taskAttachment: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/tasks/task-file-storage", () => ({
  deleteTaskAttachmentByStorageKey: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { deleteTaskAttachmentByStorageKey } = await import("@/lib/tasks/task-file-storage");
const { pruneExpiredStagedTaskAttachments } = await import("./task-attachment-janitor");

describe("task attachment janitor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims an expired unbound upload before deleting its file", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", taskId: "task-1", storageKey: "att-1--notes.txt", status: "uploaded" },
    ] as any);
    vi.mocked(db.taskAttachment.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.taskAttachment.deleteMany).mockResolvedValue({ count: 1 } as any);
    const now = new Date("2026-08-02T00:00:00Z");

    await expect(pruneExpiredStagedTaskAttachments(now)).resolves.toBe(1);

    expect(db.taskAttachment.updateMany).toHaveBeenCalledWith({
      where: { id: "att-1", status: "uploaded", messageId: null, expiresAt: { lte: now } },
      data: { status: "expiring" },
    });
    expect(deleteTaskAttachmentByStorageKey).toHaveBeenCalledWith("task-1", "att-1--notes.txt");
  });

  it("does not delete a file when message binding wins the claim race", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", taskId: "task-1", storageKey: "att-1--notes.txt", status: "uploaded" },
    ] as any);
    vi.mocked(db.taskAttachment.updateMany).mockResolvedValue({ count: 0 } as any);

    await expect(pruneExpiredStagedTaskAttachments()).resolves.toBe(0);
    expect(deleteTaskAttachmentByStorageKey).not.toHaveBeenCalled();
    expect(db.taskAttachment.deleteMany).not.toHaveBeenCalled();
  });

  it("resumes cleanup for a previously claimed attachment", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", taskId: "task-1", storageKey: "att-1--notes.txt", status: "expiring" },
    ] as any);
    vi.mocked(db.taskAttachment.deleteMany).mockResolvedValue({ count: 1 } as any);

    await expect(pruneExpiredStagedTaskAttachments()).resolves.toBe(1);
    expect(db.taskAttachment.updateMany).not.toHaveBeenCalled();
    expect(deleteTaskAttachmentByStorageKey).toHaveBeenCalledOnce();
  });

  it("keeps a claimed row for retry when physical deletion fails", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", taskId: "task-1", storageKey: "att-1--notes.txt", status: "expiring" },
    ] as any);
    vi.mocked(deleteTaskAttachmentByStorageKey).mockRejectedValue(new Error("permission denied"));

    await expect(pruneExpiredStagedTaskAttachments()).resolves.toBe(0);
    expect(db.taskAttachment.deleteMany).not.toHaveBeenCalled();
  });
});
