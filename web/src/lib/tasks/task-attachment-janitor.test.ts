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
  taskAttachmentTtlMs: () => 10 * 60 * 1000,
}));

const { db } = await import("@/lib/db");
const { deleteTaskAttachmentByStorageKey } = await import("@/lib/tasks/task-file-storage");
const { pruneExpiredStagedTaskAttachments, pruneMaterializedTaskAttachmentFiles } = await import("./task-attachment-janitor");

describe("task attachment janitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.taskAttachment.updateMany).mockResolvedValue({ count: 0 } as any);
  });

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

  it("never treats a bound but unmaterialized attachment as expirable", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([] as any);
    const now = new Date("2026-08-02T00:00:00Z");

    await pruneExpiredStagedTaskAttachments(now);
    await pruneMaterializedTaskAttachmentFiles(now);

    // A `bound` attachment has no confirmed Daemon copy yet: deleting it would
    // strand the message. Neither sweep may select one.
    for (const call of vi.mocked(db.taskAttachment.findMany).mock.calls) {
      const status = (call[0] as any).where.status;
      const statuses = typeof status === "string" ? [status] : status.in;
      expect(statuses).not.toContain("bound");
    }
    expect(deleteTaskAttachmentByStorageKey).not.toHaveBeenCalled();
  });

  it("releases a delivered attachment file once the TTL has elapsed", async () => {
    const now = new Date("2026-08-02T00:00:00Z");
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", taskId: "task-1", storageKey: "att-1--shot.png" },
    ] as any);
    vi.mocked(db.taskAttachment.updateMany).mockResolvedValue({ count: 1 } as any);

    await expect(pruneMaterializedTaskAttachmentFiles(now)).resolves.toBe(1);

    // Only attachments the Daemon already verified are eligible.
    expect(db.taskAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "materialized", materializedAt: { lte: new Date("2026-08-01T23:50:00Z") } },
    }));
    expect(deleteTaskAttachmentByStorageKey).toHaveBeenCalledWith("task-1", "att-1--shot.png");
    // The row survives so message history still renders the file metadata.
    expect(db.taskAttachment.updateMany).toHaveBeenCalledWith({
      where: { id: "att-1", status: "materialized" },
      data: { status: "pruned" },
    });
    expect(db.taskAttachment.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps a delivered attachment for retry when physical deletion fails", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", taskId: "task-1", storageKey: "att-1--shot.png" },
    ] as any);
    vi.mocked(deleteTaskAttachmentByStorageKey).mockRejectedValue(new Error("permission denied"));

    await expect(pruneMaterializedTaskAttachmentFiles()).resolves.toBe(0);
    expect(db.taskAttachment.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a claimed row for retry when physical deletion fails", async () => {
    vi.mocked(db.taskAttachment.findMany).mockResolvedValue([
      { id: "att-1", taskId: "task-1", storageKey: "att-1--notes.txt", status: "expiring" },
    ] as any);
    vi.mocked(deleteTaskAttachmentByStorageKey).mockRejectedValue(new Error("permission denied"));

    await expect(pruneExpiredStagedTaskAttachments()).resolves.toBe(0);
    expect(db.taskAttachment.deleteMany).not.toHaveBeenCalled();
    expect(db.taskAttachment.updateMany).toHaveBeenCalledWith({
      where: { id: "att-1", status: "expiring", messageId: null },
      data: { expiresAt: expect.any(Date) },
    });
  });
});
