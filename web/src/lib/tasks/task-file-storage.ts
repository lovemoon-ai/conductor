import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { MessageAttachment } from "@/shared/types";

const DEFAULT_STORAGE_ROOT = path.join(process.cwd(), ".conductor-data", "task-attachments");
const DEFAULT_MIME_TYPE = "application/octet-stream";

const EXTENSION_TO_MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

const sanitizeFileName = (value: string): string => {
  const normalized = path.basename(value).replace(/[^A-Za-z0-9._-]+/g, "-");
  return normalized || "attachment";
};

const resolveStorageRoot = (): string => (
  path.resolve(process.env.CONDUCTOR_FILE_STORAGE_DIR || DEFAULT_STORAGE_ROOT)
);

export const guessMimeType = (fileName: string, fallback?: string | null): string => {
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  const extension = path.extname(fileName).toLowerCase();
  return EXTENSION_TO_MIME[extension] || DEFAULT_MIME_TYPE;
};

const resolveAttachmentDirectory = (taskId: string): string => (
  path.join(resolveStorageRoot(), taskId)
);

function buildAttachmentTimestamp(date = new Date()): string {
  return date.toISOString();
}

async function removeFileAndEmptyParents(filePath: string, stopDir: string): Promise<void> {
  await fs.rm(filePath, { force: true });
  let currentDir = path.dirname(filePath);
  const boundary = path.resolve(stopDir);
  while (currentDir.startsWith(boundary)) {
    if (currentDir === boundary) {
      const entries = await fs.readdir(currentDir).catch(() => []);
      if (entries.length === 0) {
        await fs.rmdir(currentDir).catch(() => undefined);
      }
      break;
    }
    const entries = await fs.readdir(currentDir).catch(() => []);
    if (entries.length > 0) {
      break;
    }
    await fs.rmdir(currentDir).catch(() => undefined);
    currentDir = path.dirname(currentDir);
  }
}

export async function deleteTaskAttachmentDirectory(taskId: string): Promise<void> {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    return;
  }
  await fs.rm(resolveAttachmentDirectory(normalizedTaskId), {
    recursive: true,
    force: true,
  });
}

export async function deleteTaskAttachmentByStorageKey(taskId: string, storageKey: string): Promise<void> {
  const normalizedTaskId = taskId.trim();
  const safeStorageKey = path.basename(storageKey);
  if (!normalizedTaskId || !safeStorageKey || safeStorageKey !== storageKey) {
    return;
  }
  await removeFileAndEmptyParents(
    path.join(resolveAttachmentDirectory(normalizedTaskId), safeStorageKey),
    resolveStorageRoot(),
  );
}

export async function writeTaskAttachment(params: {
  taskId: string;
  fileName: string;
  bytes: Buffer;
  mimeType?: string | null;
}): Promise<MessageAttachment & { storageKey: string; sha256: string }> {
  const taskId = params.taskId.trim();
  const originalName = sanitizeFileName(params.fileName);
  const attachmentId = randomUUID();
  const mimeType = guessMimeType(originalName, params.mimeType);
  const storedName = `${attachmentId}--${originalName}`;
  const directory = resolveAttachmentDirectory(taskId);
  const filePath = path.join(directory, storedName);
  const createdAt = new Date();

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, params.bytes);
  const sha256 = createHash("sha256").update(params.bytes).digest("hex");

  return {
    id: attachmentId,
    name: originalName,
    mimeType,
    sizeBytes: params.bytes.byteLength,
    kind: mimeType.startsWith("image/") ? "image" : "file",
    downloadUrl: `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
    createdAt: buildAttachmentTimestamp(createdAt),
    storageKey: storedName,
    sha256,
  };
}

export async function openTaskAttachmentStreamByStorageKey(
  taskId: string,
  storageKey: string,
): Promise<{ stream: nodeFs.ReadStream; sizeBytes: number } | null> {
  const safeStorageKey = path.basename(storageKey);
  if (!safeStorageKey || safeStorageKey !== storageKey) return null;
  const filePath = path.join(resolveAttachmentDirectory(taskId), safeStorageKey);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { stream: nodeFs.createReadStream(filePath), sizeBytes: stat.size };
  } catch {
    return null;
  }
}
