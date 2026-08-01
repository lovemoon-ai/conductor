import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  assertTaskAttachmentStorageConfigured,
  deleteTaskAttachmentDirectory,
  pruneOrphanedTaskAttachmentFiles,
  writeTaskAttachment,
  writeTaskAttachmentStream,
} from "./task-file-storage";

describe("task-file-storage", () => {
  let tempRoot: string;
  const originalStorageDir = process.env.CONDUCTOR_FILE_STORAGE_DIR;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-attachments-"));
    process.env.CONDUCTOR_FILE_STORAGE_DIR = tempRoot;
    process.env.CONDUCTOR_FILE_STORAGE_SHARED = "true";
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

  it("requires an explicit shared storage directory in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDir = process.env.CONDUCTOR_FILE_STORAGE_DIR;
    const previousShared = process.env.CONDUCTOR_FILE_STORAGE_SHARED;
    process.env.NODE_ENV = "production";
    delete process.env.CONDUCTOR_FILE_STORAGE_DIR;
    expect(() => assertTaskAttachmentStorageConfigured()).toThrow("every Web replica mounts the same storage");
    process.env.CONDUCTOR_FILE_STORAGE_DIR = tempRoot;
    expect(() => assertTaskAttachmentStorageConfigured()).not.toThrow();
    process.env.NODE_ENV = previousNodeEnv;
    if (previousDir === undefined) delete process.env.CONDUCTOR_FILE_STORAGE_DIR;
    else process.env.CONDUCTOR_FILE_STORAGE_DIR = previousDir;
    if (previousShared === undefined) delete process.env.CONDUCTOR_FILE_STORAGE_SHARED;
    else process.env.CONDUCTOR_FILE_STORAGE_SHARED = previousShared;
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

  it("downgrades a spoofed raster MIME type to a context file", async () => {
    const attachment = await writeTaskAttachmentStream({
      taskId: "task-1", fileName: "fake.png", mimeType: "image/png",
      stream: Readable.from("<script>alert(1)</script>"), maxBytes: 1024,
    });
    expect(attachment).toMatchObject({ mimeType: "application/octet-stream", kind: "file" });
  });

  it("rejects video signatures even when name and MIME are disguised", async () => {
    const disguisedMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom00000000")]);
    await expect(writeTaskAttachmentStream({
      taskId: "task-1", fileName: "notes.txt", mimeType: "text/plain",
      stream: Readable.from(disguisedMp4), maxBytes: 1024,
    })).rejects.toMatchObject({ code: "ATTACHMENT_VIDEO" });
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

  it("removes old files that have no database storage key", async () => {
    const directory = path.join(tempRoot, "task-orphan");
    await fs.mkdir(directory, { recursive: true });
    const orphan = path.join(directory, "orphan--notes.txt");
    await fs.writeFile(orphan, "old");
    const old = new Date("2026-07-01T00:00:00Z");
    await fs.utimes(orphan, old, old);
    await expect(pruneOrphanedTaskAttachmentFiles(new Set(), new Date("2026-08-01T00:00:00Z"))).resolves.toBe(1);
    await expect(fs.access(orphan)).rejects.toThrow();
  });
});
