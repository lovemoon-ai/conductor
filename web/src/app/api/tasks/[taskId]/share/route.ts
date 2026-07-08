import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { generateShareToken, SHARED_TASK_KIND_USER } from "@/lib/tasks/shared-task";

const SHARE_LINK_TTL_DAYS = 7;

function buildShareExpiration(from = new Date()): Date {
  return new Date(from.getTime() + SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export async function POST(
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

  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const now = new Date();
    const shareKey = {
      taskId,
      userId: user.id,
      kind: SHARED_TASK_KIND_USER,
    };

    const existingShare = await db.sharedTask.findUnique({
      where: {
        taskId_userId_kind: shareKey,
      },
    });

    if (existingShare && (!existingShare.expiresAt || existingShare.expiresAt.getTime() > now.getTime())) {
      return NextResponse.json({
        token: existingShare.token,
        expiresAt: existingShare.expiresAt?.toISOString() ?? null,
      });
    }

    const expiresAt = buildShareExpiration(now);
    const token = generateShareToken();

    const shared = await db.sharedTask.upsert({
      where: {
        taskId_userId_kind: shareKey,
      },
      update: {
        token,
        expiresAt,
      },
      create: {
        taskId,
        userId: user.id,
        kind: SHARED_TASK_KIND_USER,
        token,
        expiresAt,
      },
    });
    return NextResponse.json({
      token: shared.token,
      expiresAt: shared.expiresAt?.toISOString() ?? expiresAt.toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create share link" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;

  const deleted = await db.sharedTask.deleteMany({
    where: { taskId, userId: user.id, kind: SHARED_TASK_KIND_USER },
  });

  if (deleted.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
