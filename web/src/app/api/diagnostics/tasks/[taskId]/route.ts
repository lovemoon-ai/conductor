import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  buildTaskDiagnosticsPayload,
  TaskDiagnosticsPayload,
} from "@/lib/diagnostics/task-diagnostics";

const parseSnapshotPayload = (raw: string): TaskDiagnosticsPayload | null => {
  try {
    const parsed = JSON.parse(raw) as TaskDiagnosticsPayload;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (!parsed.task || typeof parsed.task !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const payload = await buildTaskDiagnosticsPayload({
    userId: user.id,
    taskId,
  });

  if (payload) {
    return NextResponse.json({
      ...payload,
      source: "live",
    });
  }

  const latestSnapshot = await db.taskDiagnosticsSnapshot.findFirst({
    where: {
      userId: user.id,
      taskId,
    },
    orderBy: { createdAt: "desc" },
    select: {
      payloadJson: true,
      trigger: true,
      createdAt: true,
    },
  });

  if (!latestSnapshot) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const snapshotPayload = parseSnapshotPayload(latestSnapshot.payloadJson);
  if (!snapshotPayload) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...snapshotPayload,
    source: "snapshot",
    snapshot_trigger: latestSnapshot.trigger,
    snapshot_created_at: latestSnapshot.createdAt.toISOString(),
  });
}
