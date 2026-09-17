import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { startPersistentRound } from "@/lib/tasks/persistent-round";
import { serializeTaskResponse } from "@/lib/tasks/serialization";

const startRoundSchema = z.object({
  content: z.string().trim().min(1, "content is required"),
  backend_type: z.string().trim().min(1).optional(),
  agent_host: z.string().trim().min(1).optional(),
  worktree: z.enum(["inherit", "new", "none"]).optional(),
  expected_round: z.number().int().positive().optional(),
});

/** RFC 0039: start a new round (a fresh AI session) on a persistent task. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const { taskId } = await params;
  const parsed = startRoundSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  const result = await startPersistentRound({
    userId: userResult.id,
    taskId,
    content: parsed.data.content,
    backendType: parsed.data.backend_type,
    agentHost: parsed.data.agent_host,
    worktree: parsed.data.worktree,
    expectedRound: parsed.data.expected_round,
  });
  if (!result.ok) {
    return NextResponse.json(result.details ?? { error: result.error }, { status: result.status });
  }
  return NextResponse.json(serializeTaskResponse(result.task));
}
