import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { cancelScheduledMessageForTask } from "@/lib/tasks/scheduled-messages";
import {
  agentWriteDenied,
  resolveRequestScheduleAccess,
} from "@/lib/tasks/agent-schedule-access";

const SCHEDULED_MESSAGE_NOT_DELETABLE_ERROR =
  "Scheduled message is already completed, canceled, or does not exist";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string; scheduleId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const { taskId, scheduleId } = await params;

  const access = await resolveRequestScheduleAccess({
    request,
    userId: userResult.id,
    taskId,
  });
  if (access !== "not_agent") {
    const denied = agentWriteDenied(access);
    if (denied) return NextResponse.json(denied, { status: 403 });
  }

  const canceled = await cancelScheduledMessageForTask({
    userId: userResult.id,
    taskId,
    scheduleId,
  });

  if (!canceled) {
    return NextResponse.json({ error: SCHEDULED_MESSAGE_NOT_DELETABLE_ERROR }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}
