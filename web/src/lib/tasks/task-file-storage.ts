import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { MessageAttachment } from "@/shared/types";

const DEFAULT_STORAGE_ROOT = path.join(process.cwd(), ".conductor-data", "task-attachments");
const DEFAULT_MIME_TYPE = "application/octet-stream";
const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

export function assertTaskAttachmentStorageConfigured(): void {
  if (process.env.NODE_ENV === "production"
      && (!process.env.CONDUCTOR_FILE_STORAGE_DIR?.trim() || process.env.CONDUCTOR_FILE_STORAGE_SHARED !== "true")) {
    throw new Error("Production attachments require CONDUCTOR_FILE_STORAGE_DIR and CONDUCTOR_FILE_STORAGE_SHARED=true after verifying every Web replica mounts the same storage");
  }
}

export const guessMimeType = (fileName: string, fallback?: string | null): string => {
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  const extension = path.extname(fileName).toLowerCase();
  return EXTENSION_TO_MIME[extension] || DEFAULT_MIME_TYPE;
};

function matchesImageSignature(mimeType: string, prefix: Buffer): boolean {
  if (mimeType === "image/png") return prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (mimeType === "image/gif") return prefix.subarray(0, 6).toString("ascii") === "GIF87a" || prefix.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mimeType === "image/webp") return prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function matchesVideoSignature(prefix: Buffer): boolean {
  if (prefix.indexOf(Buffer.from("ftyp"), 4) >= 4) return true;
  if (prefix.subarray(0, 3).toString("ascii") === "FLV") return true;
  if (prefix.subarray(0, 16).equals(Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex"))) return true;
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF"
      && prefix.subarray(8, 12).toString("ascii") === "AVI ") return true;
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true;
  if (prefix.length > 188 && prefix[0] === 0x47 && prefix[188] === 0x47) return true;
  return prefix.length >= 4 && prefix[0] === 0x00 && prefix[1] === 0x00 && prefix[2] === 0x01
    && (prefix[3] === 0xba || prefix[3] === 0xb3);
}

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

export async function pruneOrphanedTaskAttachmentFiles(
  knownStorageKeys: Set<string>,
  olderThan: Date,
): Promise<number> {
  const root = resolveStorageRoot();
  const taskDirectories = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  let deleted = 0;
  for (const taskDirectory of taskDirectories) {
    if (!taskDirectory.isDirectory()) continue;
    const directory = path.join(root, taskDirectory.name);
    const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || knownStorageKeys.has(file.name)) continue;
      const filePath = path.join(directory, file.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || stat.mtime >= olderThan) continue;
      await removeFileAndEmptyParents(filePath, root);
      deleted += 1;
    }
  }
  return deleted;
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
  let mimeType = guessMimeType(originalName, params.mimeType).toLowerCase();
  const storedName = `${attachmentId}--${originalName}`;
  const directory = resolveAttachmentDirectory(taskId);
  const filePath = path.join(directory, storedName);
  const createdAt = new Date();

  if (matchesVideoSignature(params.bytes.subarray(0, 512))) {
    throw Object.assign(new Error("video attachments are not supported"), { code: "ATTACHMENT_VIDEO" });
  }

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, params.bytes);
  const sha256 = createHash("sha256").update(params.bytes).digest("hex");
  if (NATIVE_IMAGE_TYPES.has(mimeType) && !matchesImageSignature(mimeType, params.bytes.subarray(0, 12))) {
    mimeType = DEFAULT_MIME_TYPE;
  }

  return {
    id: attachmentId,
    name: originalName,
    mimeType,
    sizeBytes: params.bytes.byteLength,
    kind: NATIVE_IMAGE_TYPES.has(mimeType) ? "image" : "file",
    downloadUrl: `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
    createdAt: buildAttachmentTimestamp(createdAt),
    storageKey: storedName,
    sha256,
  };
}

export async function writeTaskAttachmentStream(params: {
  taskId: string;
  fileName: string;
  stream: Readable;
  mimeType?: string | null;
  maxBytes: number;
}): Promise<MessageAttachment & { storageKey: string; sha256: string }> {
  const taskId = params.taskId.trim();
  const originalName = sanitizeFileName(params.fileName);
  const attachmentId = randomUUID();
  let mimeType = guessMimeType(originalName, params.mimeType).toLowerCase();
  const storedName = `${attachmentId}--${originalName}`;
  const directory = resolveAttachmentDirectory(taskId);
  const finalPath = path.join(directory, storedName);
  const temporaryPath = path.join(directory, `.${attachmentId}.uploading`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let prefix = Buffer.alloc(0);

  await fs.mkdir(directory, { recursive: true });
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength;
      if (prefix.byteLength < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.byteLength)]);
      if (matchesVideoSignature(prefix)) {
        callback(Object.assign(new Error("video attachments are not supported"), { code: "ATTACHMENT_VIDEO" }));
        return;
      }
      if (sizeBytes > params.maxBytes) {
        callback(Object.assign(new Error("file too large"), { code: "ATTACHMENT_TOO_LARGE" }));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(params.stream, meter, nodeFs.createWriteStream(temporaryPath, { flags: "wx" }));
    if (sizeBytes === 0) {
      throw Object.assign(new Error("file is empty"), { code: "ATTACHMENT_EMPTY" });
    }
    await fs.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  if (NATIVE_IMAGE_TYPES.has(mimeType) && !matchesImageSignature(mimeType, prefix)) {
    mimeType = DEFAULT_MIME_TYPE;
  }

  return {
    id: attachmentId,
    name: originalName,
    mimeType,
    sizeBytes,
    kind: NATIVE_IMAGE_TYPES.has(mimeType) ? "image" : "file",
    downloadUrl: `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
    createdAt: buildAttachmentTimestamp(),
    storageKey: storedName,
    sha256: hash.digest("hex"),
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
