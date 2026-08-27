import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import {
  parseAgentScheduleAccess,
  readAgentScheduleAccessFromMetadata,
  setAgentScheduleAccessForTask,
} from "@/lib/tasks/agent-schedule-access";

/**
 * Human control over what an autonomous agent turn may do with this task's
 * scheduled messages (full | read_only | blocked). Tightening takes effect on
 * the agent's next scheduling call.
 *
 * GET /api/tasks/{taskId}/agent-schedule-access
 * PUT /api/tasks/{taskId}/agent-schedule-access   { access: "read_only" }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const { taskId } = await params;

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: userResult.id } },
    select: { metadata: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    task_id: taskId,
    access: readAgentScheduleAccessFromMetadata(task.metadata),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const [{ taskId }, body] = await Promise.all([
    params,
    request.json().catch(() => null),
  ]);

  const access = parseAgentScheduleAccess((body as { access?: unknown } | null)?.access);
  if (!access) {
    return NextResponse.json(
      { error: "invalid_access", message: "access must be one of full, read_only, blocked" },
      { status: 400 },
    );
  }

  const stored = await setAgentScheduleAccessForTask({
    userId: userResult.id,
    taskId,
    access,
  });
  if (!stored) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ task_id: taskId, access: stored });
}
