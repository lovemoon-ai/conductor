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

  let message;
  try {
    ({ message } = await appendUserMessageToTask({
      userId: user.id,
      taskId,
      content: body.content,
      role: body.role ?? "sdk",
      metadata: body.metadata ?? null,
    }));
  } catch (error) {
    if (error instanceof TaskIngressError) {
      return NextResponse.json(error.details ?? { error: error.message }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json(buildMessageResponse(message));
}
