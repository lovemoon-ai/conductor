import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { endPersistentRound } from "@/lib/tasks/persistent-round";
import { serializeTaskResponse } from "@/lib/tasks/serialization";

/** RFC 0039: end the current round of a persistent task (asks the AI for a summary). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  const { taskId } = await params;
  const result = await endPersistentRound({ userId: userResult.id, taskId });
  if (!result.ok) {
    return NextResponse.json(result.details ?? { error: result.error }, { status: result.status });
  }
  return NextResponse.json(serializeTaskResponse(result.task));
}
