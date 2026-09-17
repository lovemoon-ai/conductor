import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  broadcastPersistentTaskUpdate,
  readPersistentSettingsInput,
  updateTaskMetadata,
  withPersistentState,
} from "@/lib/tasks/persistent-task";
import { serializeTaskResponse } from "@/lib/tasks/serialization";

/**
 * RFC 0039: turn a task persistent on/off and edit its standing instructions
 * and rolling summary. A dedicated endpoint so these keys are merged inside
 * `metadata.persistent` without round-tripping the server-owned round state.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const settings = readPersistentSettingsInput(body as Record<string, unknown>);
  if ("error" in settings) {
    return NextResponse.json({ error: settings.error }, { status: 400 });
  }

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: { id: true, taskType: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ((task.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json({ error: "Only ai_task can be persistent" }, { status: 409 });
  }

  const written = await updateTaskMetadata(db.task, task.id, (metadata) =>
    withPersistentState(metadata, {
      ...settings,
      // A task that stops being persistent must not keep a half-finished round
      // (e.g. a pending summary request that would lock its composer).
      ...(settings.enabled === false ? { roundEndedAt: null, roundEndMessageId: null } : {}),
    }),
  );
  if (written) {
    broadcastPersistentTaskUpdate({ userId: user.id, taskId: task.id, ...written });
  }
  const updated = await db.task.findUnique({
    where: { id: task.id },
    include: { ptySession: true },
  });
  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(serializeTaskResponse(updated));
}
