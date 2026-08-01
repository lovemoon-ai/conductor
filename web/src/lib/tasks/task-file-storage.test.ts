import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deleteTaskAttachmentDirectory,
  writeTaskAttachment,
} from "./task-file-storage";

describe("task-file-storage", () => {
  let tempRoot: string;
  const originalStorageDir = process.env.CONDUCTOR_FILE_STORAGE_DIR;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-attachments-"));
    process.env.CONDUCTOR_FILE_STORAGE_DIR = tempRoot;
  });

  afterEach(async () => {
    if (originalStorageDir === undefined) {
      delete process.env.CONDUCTOR_FILE_STORAGE_DIR;
    } else {
      process.env.CONDUCTOR_FILE_STORAGE_DIR = originalStorageDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("stores attachment creation and digest metadata on write", async () => {
    const attachment = await writeTaskAttachment({
      taskId: "task-1",
      fileName: "diagram.png",
      bytes: Buffer.from("png-data"),
      mimeType: "image/png",
    });

    expect(attachment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(attachment.sha256).toHaveLength(64);
  });

  it("treats non-image uploads as context files", async () => {
    const attachment = await writeTaskAttachment({
      taskId: "task-1",
      fileName: "recording.mp3",
      bytes: Buffer.from("audio-data"),
      mimeType: "audio/mpeg",
    });
    expect(attachment.kind).toBe("file");
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
