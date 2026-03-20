import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  TaskIngressError,
  appendUserMessageToTask,
} from "@/lib/channel/task-ingress-service";
import { db } from "@/lib/db";
import { buildMessageResponse } from "@/lib/conductor/message-attachments";

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
  });

  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const messages = await db.message.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(messages.map((message) => buildMessageResponse(message)));
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

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
  });
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
