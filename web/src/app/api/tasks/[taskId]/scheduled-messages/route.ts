import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  ScheduledMessageError,
  createScheduledMessageForTask,
  listScheduledMessagesForTask,
} from "@/lib/tasks/scheduled-messages";
import {
  agentReadDenied,
  agentWriteDenied,
  resolveRequestScheduleAccess,
} from "@/lib/tasks/agent-schedule-access";
import {
  scheduleSchema,
  scheduledMessageStatusFilterSchema,
} from "@/lib/tasks/scheduled-message-schema";

const listQuerySchema = z.object({
  status: scheduledMessageStatusFilterSchema.nullish(),
  q: z.string().nullish(),
});

const createScheduledMessageSchema = z.object({
  content: z.string().min(1),
  sourceMessageId: z.string().trim().min(1).optional().nullable(),
  source_message_id: z.string().trim().min(1).optional().nullable(),
  schedule: scheduleSchema,
});

const errorResponse = (error: unknown): Response => {
  if (error instanceof ScheduledMessageError) {
    return NextResponse.json(error.details, { status: error.status });
  }
  throw error;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const { taskId } = await params;

  const access = await resolveRequestScheduleAccess({
    request,
    userId: userResult.id,
    taskId,
  });
  if (access !== "not_agent") {
    const denied = agentReadDenied(access);
    if (denied) return NextResponse.json(denied, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  // An unknown status would otherwise reach Prisma and quietly match nothing,
  // which reads as "no schedules" instead of "you sent a typo".
  const query = listQuerySchema.safeParse({
    status: searchParams.get("status"),
    q: searchParams.get("q"),
  });
  if (!query.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: query.error.issues[0]?.message ?? "Invalid scheduled message filter",
      },
      { status: 400 },
    );
  }

  try {
    const schedules = await listScheduledMessagesForTask({
      userId: userResult.id,
      taskId,
      status: query.data.status,
      keyword: query.data.q,
    });
    return NextResponse.json({ schedules });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const [{ taskId }, rawBody] = await Promise.all([
    params,
    request.json().catch(() => null),
  ]);

  const parsed = createScheduledMessageSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid scheduled message request",
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
    const schedule = await createScheduledMessageForTask({
      userId: userResult.id,
      taskId,
      sourceMessageId: parsed.data.sourceMessageId ?? parsed.data.source_message_id ?? null,
      content: parsed.data.content,
      schedule: parsed.data.schedule,
    });
    return NextResponse.json(schedule, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
