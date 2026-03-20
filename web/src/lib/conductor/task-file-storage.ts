import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { MessageAttachment } from "./types";
import { attachmentKindFromMimeType } from "./message-attachments";

const DEFAULT_STORAGE_ROOT = path.join(process.cwd(), ".conductor-data", "task-attachments");
const DEFAULT_MIME_TYPE = "application/octet-stream";
const DEFAULT_ATTACHMENT_TTL_MINUTES = 10;
const DEFAULT_ATTACHMENT_SWEEP_INTERVAL_MS = 60_000;

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

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const resolveStorageRoot = (): string => (
  path.resolve(process.env.CONDUCTOR_FILE_STORAGE_DIR || DEFAULT_STORAGE_ROOT)
);

const resolveAttachmentTtlMs = (): number => (
  parsePositiveInteger(process.env.CONDUCTOR_ATTACHMENT_TTL_MINUTES, DEFAULT_ATTACHMENT_TTL_MINUTES) * 60 * 1000
);

const resolveAttachmentSweepIntervalMs = (): number => (
  parsePositiveInteger(process.env.CONDUCTOR_ATTACHMENT_SWEEP_INTERVAL_MS, DEFAULT_ATTACHMENT_SWEEP_INTERVAL_MS)
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

function buildAttachmentExpiration(createdAt = new Date()): string {
  return new Date(createdAt.getTime() + resolveAttachmentTtlMs()).toISOString();
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

async function isExpiredFile(filePath: string, now = Date.now()): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return true;
  }
  return stat.mtimeMs + resolveAttachmentTtlMs() <= now;
}

export async function pruneExpiredTaskAttachments(options: { now?: number } = {}): Promise<number> {
  const now = typeof options.now === "number" ? options.now : Date.now();
  const root = resolveStorageRoot();
  const taskDirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  let deletedCount = 0;

  for (const taskDir of taskDirs) {
    if (!taskDir.isDirectory()) {
      continue;
    }
    const taskPath = path.join(root, taskDir.name);
    const entries = await fs.readdir(taskPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(taskPath, entry.name);
      if (!(await isExpiredFile(filePath, now))) {
        continue;
      }
      await removeFileAndEmptyParents(filePath, root).catch(() => undefined);
      deletedCount += 1;
    }
  }

  return deletedCount;
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

export function startTaskAttachmentJanitor(log: Pick<Console, "info" | "error"> = console): NodeJS.Timeout {
  const intervalMs = resolveAttachmentSweepIntervalMs();
  const timer = setInterval(() => {
    void pruneExpiredTaskAttachments()
      .then((deletedCount) => {
        if (deletedCount > 0) {
          log.info?.(`[attachments] pruned ${deletedCount} expired attachment file(s)`);
        }
      })
      .catch((error) => {
        log.error?.(`[attachments] failed to prune expired attachments: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, Math.max(intervalMs, 1000));
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

export async function writeTaskAttachment(params: {
  taskId: string;
  fileName: string;
  bytes: Buffer;
  mimeType?: string | null;
}): Promise<MessageAttachment> {
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

  return {
    id: attachmentId,
    name: originalName,
    mimeType,
    sizeBytes: params.bytes.byteLength,
    kind: attachmentKindFromMimeType(mimeType),
    downloadUrl: `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
    createdAt: buildAttachmentTimestamp(createdAt),
    expiresAt: buildAttachmentExpiration(createdAt),
  };
}

async function resolveStoredAttachmentPath(taskId: string, attachmentId: string): Promise<string | null> {
  const directory = resolveAttachmentDirectory(taskId);
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return null;
  }
  const prefix = `${attachmentId}--`;
  const match = entries.find((entry) => entry.startsWith(prefix));
  if (!match) {
    return null;
  }
  return path.join(directory, match);
}

export async function readTaskAttachment(taskId: string, attachmentId: string): Promise<Buffer | null> {
  const filePath = await resolveStoredAttachmentPath(taskId, attachmentId);
  if (!filePath) {
    return null;
  }
  const root = resolveStorageRoot();
  if (await isExpiredFile(filePath)) {
    await removeFileAndEmptyParents(filePath, root).catch(() => undefined);
    return null;
  }
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}
