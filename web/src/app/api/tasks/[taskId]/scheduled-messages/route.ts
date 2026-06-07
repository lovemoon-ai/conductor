import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  ScheduledMessageError,
  createScheduledMessageForTask,
  listScheduledMessagesForTask,
} from "@/lib/tasks/scheduled-messages";

const positiveInteger = z.number().int().positive();

const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("delay"),
    amount: positiveInteger,
    unit: z.enum(["minute", "hour"]),
  }),
  z.object({
    mode: z.literal("at"),
    sendAt: z.string().min(1),
    timezone: z.string().trim().min(1).optional().nullable(),
  }),
  z.object({
    mode: z.literal("interval"),
    every: positiveInteger,
    unit: z.enum(["minute", "hour"]),
    condition: z.enum(["none", "ai_idle"]).optional(),
    stop: z.object({
      maxRuns: positiveInteger.optional().nullable(),
      maxSkips: positiveInteger.optional().nullable(),
      stopAt: z.string().min(1).optional().nullable(),
      stopWhenTaskNotRunning: z.boolean().optional().nullable(),
    }).optional().nullable(),
  }),
]);

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
  try {
    const schedules = await listScheduledMessagesForTask({
      userId: userResult.id,
      taskId,
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
