import type { Message, MessageAttachment } from "@/shared/types";

type JsonRecord = Record<string, unknown>;
export type SerializedMessage = Message & {
  task_id: string;
  created_at: string;
};

function parseJsonRecord(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonRecord;
  } catch {
    return null;
  }
}

export function normalizeMessageMetadata(value: unknown): JsonRecord | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return parseJsonRecord(value);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return null;
}

export function attachmentKindFromMimeType(mimeType: string): MessageAttachment["kind"] {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return Number.isNaN(Date.parse(normalized)) ? undefined : normalized;
}

function isExpiredAttachment(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  return Date.parse(expiresAt) <= Date.now();
}

function normalizeAttachment(value: unknown): MessageAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
  const downloadUrl = typeof record.downloadUrl === "string" ? record.downloadUrl.trim() : "";
  const sizeBytes =
    typeof record.sizeBytes === "number"
      ? record.sizeBytes
      : typeof record.size_bytes === "number"
        ? record.size_bytes
        : Number.NaN;
  const kindSource = typeof record.kind === "string" ? record.kind.trim() : "";
  const kind = kindSource || attachmentKindFromMimeType(mimeType);
  const createdAt = normalizeIsoTimestamp(record.createdAt ?? record.created_at);
  const expiresAt = normalizeIsoTimestamp(record.expiresAt ?? record.expires_at);
  const sha256 = typeof record.sha256 === "string" ? record.sha256.trim().toLowerCase() : undefined;
  const status = typeof record.status === "string" ? record.status.trim() : undefined;

  if (!id || !name || !mimeType || !downloadUrl || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return null;
  }

  if (kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "file") {
    return null;
  }
  if (isExpiredAttachment(expiresAt)) {
    return null;
  }

  return {
    id,
    name,
    mimeType,
    sizeBytes,
    kind,
    downloadUrl,
    createdAt,
    expiresAt,
    sha256,
    status: status as MessageAttachment["status"],
  };
}

export function getMessageAttachments(value: unknown): MessageAttachment[] {
  const metadata = normalizeMessageMetadata(value);
  const rawAttachments = metadata?.attachments;
  if (!Array.isArray(rawAttachments)) {
    return [];
  }
  return rawAttachments
    .map((attachment) => normalizeAttachment(attachment))
    .filter((attachment): attachment is MessageAttachment => Boolean(attachment));
}

export function buildMessageResponse(message: {
  id: string;
  taskId: string;
  role: string;
  content: string;
  metadata?: unknown;
  createdAt: Date | string;
}): SerializedMessage {
  const metadata = normalizeMessageMetadata(message.metadata);
  const attachments = getMessageAttachments(metadata);
  return {
    id: message.id,
    taskId: message.taskId,
    task_id: message.taskId,
    role: message.role as Message["role"],
    content: message.content,
    metadata,
    attachments,
    createdAt:
      message.createdAt instanceof Date
        ? message.createdAt.toISOString()
        : String(message.createdAt),
    created_at:
      message.createdAt instanceof Date
        ? message.createdAt.toISOString()
        : String(message.createdAt),
  };
}
