import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  TaskIngressError,
  appendUserMessageToTask,
} from "@/lib/channel/task-ingress-service";
import { db } from "@/lib/db";
import { buildMessageResponse } from "@/shared/utils/message-attachments";
import {
  isMissingAnyNewSchemaError,
} from "@/lib/tasks/pty-compat";
import { stripTopLevelAuditKeys } from "@/lib/audit/metadata";

const parseStoredMetadata = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const normalizeClientRequestId = (body: Record<string, unknown> | null): string | null => {
  if (!body) return null;
  const candidate = body.clientRequestId ?? body.client_request_id;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed || null;
};

/**
 * Scan window for the idempotency lookup. We only inspect the most recent N
 * messages on the task because a retried client typically sends within
 * seconds of the original. Avoids the full-table fetch the original
 * implementation did — a long-running task with thousands of messages would
 * otherwise pay a large cost on every retry (review H3).
 */
const IDEMPOTENCY_SCAN_LIMIT = 200;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const parsePageSize = (value: string | null): number => {
  if (!value) {
    return DEFAULT_PAGE_SIZE;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
};

const shouldReturnPaginatedShape = (value: string | null): boolean => (
  value === "1" || value === "true" || value === "page" || value === "paginated"
);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: { id: true },
  });

  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const beforeId = searchParams.get("before_id");
  const pageSize = parsePageSize(searchParams.get("limit"));
  const paginated = shouldReturnPaginatedShape(searchParams.get("pagination"));

  if (!paginated) {
    const messages = await db.message.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json(messages.map((message) => buildMessageResponse(message)));
  }

  let cursorFilter:
    | {
        OR: Array<
          | { createdAt: { lt: Date } }
          | { createdAt: Date; id: { lt: string } }
        >;
      }
    | undefined;

  if (beforeId) {
    const cursorMessage = await db.message.findFirst({
      where: { id: beforeId, taskId },
      select: {
        id: true,
        createdAt: true,
      },
    });

    if (!cursorMessage) {
      return NextResponse.json({ error: "invalid_before_id" }, { status: 400 });
    }

    cursorFilter = {
      OR: [
        { createdAt: { lt: cursorMessage.createdAt } },
        { createdAt: cursorMessage.createdAt, id: { lt: cursorMessage.id } },
      ],
    };
  }

  const messages = await db.message.findMany({
    where: {
      taskId,
      ...(cursorFilter ?? {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
  });

  const hasMoreBefore = messages.length > pageSize;
  const pageMessages = (hasMoreBefore ? messages.slice(0, pageSize) : messages).reverse();

  const serializedMessages = pageMessages.map((message) => buildMessageResponse(message));

  return NextResponse.json({
    messages: serializedMessages,
    pagination: {
      has_more_before: hasMoreBefore,
      oldest_message_id: pageMessages[0]?.id ?? null,
      page_size: pageSize,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const body = await request.json();

  if (!body?.content) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  let task: { id: string; projectId: string; taskType?: string | null } | null;
  try {
    task = await db.task.findFirst({
      where: { id: taskId, project: { userId: user.id } },
      select: { id: true, projectId: true, taskType: true },
    });
  } catch (error) {
    if (!isMissingAnyNewSchemaError(error)) throw error;
    task = await db.task.findFirst({
      where: { id: taskId, project: { userId: user.id } },
      select: { id: true, projectId: true },
    });
  }
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (task.taskType === "pty_task") {
    return NextResponse.json(
      { error: "task_type_not_messageable", message: "pty_task does not accept chat messages" },
      { status: 409 },
    );
  }

  // Optional idempotency key (RFC 0025 §5.1). When provided, dedupe within
  // this task's message history by `metadata.clientRequestId`. Stored on the
  // existing JSON `metadata` column (no schema change).
  //
  // Scan is bounded to the most recent N messages — a retried request will
  // target a write-window measured in seconds, so older history doesn't need
  // to be re-scanned (review H3).
  const clientRequestId = normalizeClientRequestId(body);
  const rawCallerMetadata: Record<string, unknown> | null =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : null;
  const callerMetadata = stripTopLevelAuditKeys(rawCallerMetadata);
  if (clientRequestId) {
    const taskMessages = await db.message.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      take: IDEMPOTENCY_SCAN_LIMIT,
    });
    const existing = taskMessages.find((message) => {
      const parsed = parseStoredMetadata((message as { metadata?: unknown }).metadata);
      return parsed && parsed.clientRequestId === clientRequestId;
    });
    if (existing) {
      return NextResponse.json(buildMessageResponse(existing));
    }
  }

  // Persist the structured metadata (after the top-level audit strip above).
  // The `metadata.audit.*` namespace is preserved verbatim, so SDK / CLI
  // audit traces survive the round trip (RFC §5.2).
  const mergedMetadata: Record<string, unknown> | null = clientRequestId
    ? { ...(callerMetadata ?? {}), clientRequestId }
    : callerMetadata;

  let message;
  try {
    ({ message } = await appendUserMessageToTask({
      userId: user.id,
      taskId,
      content: body.content,
      role: body.role ?? "sdk",
      metadata: mergedMetadata,
    }));
  } catch (error) {
    if (error instanceof TaskIngressError) {
      return NextResponse.json(error.details ?? { error: error.message }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json(buildMessageResponse(message));
}
