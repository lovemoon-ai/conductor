import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  ScheduledMessageError,
  cancelScheduledMessageForTask,
  deleteScheduledMessageForTask,
  getScheduledMessageStatusForTask,
  updateScheduledMessageForTask,
} from "@/lib/tasks/scheduled-messages";
import {
  agentWriteDenied,
  resolveRequestScheduleAccess,
} from "@/lib/tasks/agent-schedule-access";
import { scheduleSchema } from "@/lib/tasks/scheduled-message-schema";

const SCHEDULED_MESSAGE_NOT_DELETABLE_ERROR =
  "Scheduled message is already completed, canceled, or does not exist";

const updateScheduledMessageSchema = z
  .object({
    content: z.string().min(1).optional(),
    schedule: scheduleSchema.optional(),
  })
  .refine((value) => value.content !== undefined || value.schedule !== undefined, {
    message: "Provide content or schedule to update",
  });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string; scheduleId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const [{ taskId, scheduleId }, rawBody] = await Promise.all([
    params,
    request.json().catch(() => null),
  ]);

  const parsed = updateScheduledMessageSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid scheduled message update",
      },
      { status: 400 },
    );
  }

  const access = await resolveRequestScheduleAccess({
    request,
    userId: userResult.id,
    taskId,
  });
  if (access !== "not_agent") {
    const denied = agentWriteDenied(access);
    if (denied) return NextResponse.json(denied, { status: 403 });
  }

  try {
    const updated = await updateScheduledMessageForTask({
      userId: userResult.id,
      taskId,
      scheduleId,
      content: parsed.data.content,
      schedule: parsed.data.schedule,
    });
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof ScheduledMessageError) {
      return NextResponse.json(error.details, { status: error.status });
    }
    throw error;
  }
}

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

  // An active row is stopped, not erased, so its history stays auditable. Rows
  // that already finished are removed outright -- that is the only way the
  // management list can be cleaned up.
  if (!canceled) {
    const deleted = await deleteScheduledMessageForTask({
      userId: userResult.id,
      taskId,
      scheduleId,
    });
    if (!deleted) {
      // A row the dispatcher claimed matches neither branch. It exists and is
      // mid-send, so reporting it as missing would be wrong -- and would tempt
      // the client to drop it from the list.
      const status = await getScheduledMessageStatusForTask({
        userId: userResult.id,
        taskId,
        scheduleId,
      });
      if (status === "sending") {
        return NextResponse.json(
          {
            error: "schedule_in_flight",
            message: "This scheduled message is being sent right now. Try again in a moment.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: SCHEDULED_MESSAGE_NOT_DELETABLE_ERROR }, { status: 404 });
    }
  }

  return new NextResponse(null, { status: 204 });
}
