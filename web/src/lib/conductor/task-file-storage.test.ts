import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deleteTaskAttachmentDirectory,
  pruneExpiredTaskAttachments,
  readTaskAttachment,
  writeTaskAttachment,
} from "./task-file-storage";

describe("task-file-storage", () => {
  let tempRoot: string;
  const originalStorageDir = process.env.CONDUCTOR_FILE_STORAGE_DIR;
  const originalTtl = process.env.CONDUCTOR_ATTACHMENT_TTL_MINUTES;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-attachments-"));
    process.env.CONDUCTOR_FILE_STORAGE_DIR = tempRoot;
    delete process.env.CONDUCTOR_ATTACHMENT_TTL_MINUTES;
  });

  afterEach(async () => {
    if (originalStorageDir === undefined) {
      delete process.env.CONDUCTOR_FILE_STORAGE_DIR;
    } else {
      process.env.CONDUCTOR_FILE_STORAGE_DIR = originalStorageDir;
    }
    if (originalTtl === undefined) {
      delete process.env.CONDUCTOR_ATTACHMENT_TTL_MINUTES;
    } else {
      process.env.CONDUCTOR_ATTACHMENT_TTL_MINUTES = originalTtl;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("stores attachment expiration metadata on write", async () => {
    const attachment = await writeTaskAttachment({
      taskId: "task-1",
      fileName: "diagram.png",
      bytes: Buffer.from("png-data"),
      mimeType: "image/png",
    });

    expect(attachment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(attachment.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(String(attachment.expiresAt))).toBeGreaterThan(Date.parse(String(attachment.createdAt)));
  });

  it("returns null and removes files once they are expired", async () => {
    process.env.CONDUCTOR_ATTACHMENT_TTL_MINUTES = "0";

    const attachment = await writeTaskAttachment({
      taskId: "task-1",
      fileName: "diagram.png",
      bytes: Buffer.from("png-data"),
      mimeType: "image/png",
    });

    const content = await readTaskAttachment("task-1", attachment.id);
    expect(content).toBeNull();

    const taskDir = path.join(tempRoot, "task-1");
    const entries = await fs.readdir(taskDir).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("prunes stale attachments across tasks", async () => {
    process.env.CONDUCTOR_ATTACHMENT_TTL_MINUTES = "1";
    const taskDir = path.join(tempRoot, "task-1");
    await fs.mkdir(taskDir, { recursive: true });
    const filePath = path.join(taskDir, "att-1--old.png");
    await fs.writeFile(filePath, Buffer.from("old-data"));
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    await fs.utimes(filePath, oldTime, oldTime);

    const deleted = await pruneExpiredTaskAttachments({ now: Date.now() });

    expect(deleted).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("removes all attachment files for a deleted task", async () => {
    await writeTaskAttachment({
      taskId: "task-delete-1",
      fileName: "diagram.png",
      bytes: Buffer.from("png-data"),
      mimeType: "image/png",
    });

    await deleteTaskAttachmentDirectory("task-delete-1");

    await expect(fs.access(path.join(tempRoot, "task-delete-1"))).rejects.toThrow();
  });
});
