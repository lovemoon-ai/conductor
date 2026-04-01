import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const MAX_SHARED_MESSAGES = 500;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const shared = await db.sharedTask.findUnique({
    where: { token },
    include: {
      task: true,
    },
  });

  if (!shared) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (shared.expiresAt && shared.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "This shared link has expired" }, { status: 410 });
  }

  const { task } = shared;

  const rawMessages = await db.message.findMany({
    where: { taskId: task.id, role: { in: ["user", "assistant", "sdk"] } },
    orderBy: { createdAt: "asc" },
    take: MAX_SHARED_MESSAGES,
    select: { id: true, role: true, content: true, metadata: true, createdAt: true },
  });

  const messages = rawMessages.filter((msg) => {
    if (!msg.metadata) return true;
    try {
      const meta = typeof msg.metadata === "string" ? JSON.parse(msg.metadata) : msg.metadata;
      return !meta?.synthetic;
    } catch {
      return true;
    }
  });

  return NextResponse.json({
    task: {
      title: task.title,
      status: task.status,
      taskType: task.taskType,
      createdAt: task.createdAt.toISOString(),
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
  });
}
